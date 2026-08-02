import assert from 'node:assert/strict'
import test from 'node:test'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { createApiServer } from '../src/http.mjs'
import { SymbolResolver } from '../src/resolver.mjs'
import { batchRequest, bundle, listen, resolveRequest } from '../test-support/fixtures.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function barrier () {
  let resolve
  const promise = new Promise((res) => { resolve = res })
  return { promise, resolve }
}

function controllableWork () {
  let active = 0
  let max = 0
  let calls = 0
  let released = false
  const barriers = []
  const work = async () => {
    calls++
    active++
    if (active > max) max = active
    if (released) {
      active--
      return
    }
    const b = barrier()
    barriers.push(b)
    try {
      await b.promise
    } finally {
      active--
    }
  }
  return {
    work,
    stats: () => ({ active, max, calls }),
    releaseOne: () => barriers.shift()?.resolve(),
    releaseAll: () => {
      released = true
      while (barriers.length > 0) barriers.shift().resolve()
    }
  }
}

test('caps in-flight batch work at the configured concurrency', async () => {
  const registry = new BundleRegistry()
  for (let i = 1; i <= 10; i++) {
    registry.put(bundle({ version: `2026.08.${i}` }))
  }
  const cw = controllableWork()
  const resolver = new SymbolResolver(registry, { concurrency: 3, batchWork: cw.work })

  const pending = resolver.resolveBatch(batchRequest({
    requests: Array.from({ length: 10 }, (_, i) =>
      resolveRequest({ version: `2026.08.${i + 1}` }))
  }))

  await delay(30)
  assert.equal(cw.stats().active, 3, 'only three jobs should be in flight')
  assert.equal(cw.stats().max, 3)
  assert.equal(cw.stats().calls, 3)

  cw.releaseAll()
  const result = await pending
  assert.equal(result.results.length, 10)
  assert.ok(result.results.every((r) => r.ok))
})

test('deduplicates identical requests within the same batch but keeps every index', async () => {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '2026.08.1' }))
  const cw = controllableWork()
  const resolver = new SymbolResolver(registry, { concurrency: 4, batchWork: cw.work })

  const req = resolveRequest({ version: '2026.08.1' })
  const pending = resolver.resolveBatch(batchRequest({ requests: [req, req, req] }))
  await delay(20)
  cw.releaseAll()
  const result = await pending

  assert.equal(cw.stats().calls, 1, 'resolution work runs once for identical items')
  assert.equal(result.results.length, 3)
  assert.deepEqual(result.results.map((r) => r.index), [0, 1, 2])
  assert.ok(result.results.every((r) => r.ok && r.frames[0].status === 'exact'))

  result.results[0].frames[0].source.file = 'mutated.ts'
  assert.equal(result.results[1].frames[0].source.file, 'src/bootstrap.ts')
})

test('stops starting work after abort and marks queued items cancelled', async () => {
  const registry = new BundleRegistry()
  for (let i = 1; i <= 6; i++) {
    registry.put(bundle({ version: `2026.08.${i}` }))
  }
  const cw = controllableWork()
  const resolver = new SymbolResolver(registry, { concurrency: 1, batchWork: cw.work })
  const controller = new AbortController()

  const pending = resolver.resolveBatch(batchRequest({
    requests: Array.from({ length: 6 }, (_, i) =>
      resolveRequest({ version: `2026.08.${i + 1}` }))
  }), { signal: controller.signal })

  await delay(20)
  assert.equal(cw.stats().active, 1)
  controller.abort()
  cw.releaseAll()

  const result = await pending
  const completed = result.results.filter((r) => r.ok)
  const cancelled = result.results.filter((r) => !r.ok && r.error.code === 'cancelled')
  assert.ok(completed.length <= 1, 'at most the in-flight item may complete')
  assert.ok(cancelled.length >= 5, 'remaining items are cancelled')
  assert.deepEqual(
    result.results.map((r) => r.index),
    [0, 1, 2, 3, 4, 5],
    'input order is preserved'
  )

  let followUpActive = 0
  let followUpMax = 0
  const resolver2 = new SymbolResolver(registry, {
    concurrency: 2,
    batchWork: async () => {
      followUpActive++
      if (followUpActive > followUpMax) followUpMax = followUpActive
      await Promise.resolve()
      followUpActive--
    }
  })
  const second = await resolver2.resolveBatch(batchRequest({
    requests: [resolveRequest({ version: '2026.08.1' }), resolveRequest({ version: '2026.08.2' })]
  }))
  assert.ok(second.results.every((r) => r.ok), 'subsequent batches are not starved by leaked slots')
  assert.equal(followUpMax, 2, 'the full concurrency limit is available after cancellation')
})

test('keeps one immutable snapshot during a concurrent lineage switch', async () => {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '2026.08.1' }))
  registry.put(bundle({
    version: '2026.08.2',
    mappings: [
      { generated: { file: 'new.js', line: 1, column: 0 }, source: { file: 'src/new.ts', line: 1, column: 0 } }
    ]
  }))

  let switched = false
  const resolver = new SymbolResolver(registry, {
    concurrency: 2,
    batchWork: async () => {
      if (!switched) {
        switched = true
        registry.adjustLineage({
          expectedRevision: 2,
          relationships: [
            { application: 'mobile-shell', platform: 'android', version: '2026.08.2', parentVersion: '2026.08.1' }
          ]
        })
      }
      await delay(10)
    }
  })

  const result = await resolver.resolveBatch(batchRequest({
    requests: [
      resolveRequest({ version: '2026.08.2', frames: [{ file: 'app.js', line: 10, column: 2 }] }),
      resolveRequest({ version: '2026.08.2', frames: [{ file: 'new.js', line: 1, column: 0 }] })
    ]
  }))

  assert.equal(result.registryRevision, 2, 'batch is pinned to the revision captured at start')
  assert.equal(result.results[0].frames[0].status, 'unmapped', 'old lineage had no parent for v2')
  assert.equal(result.results[1].frames[0].status, 'exact')

  const after = resolver.resolve(resolveRequest({
    version: '2026.08.2',
    frames: [{ file: 'app.js', line: 10, column: 2 }]
  }))
  assert.equal(after.registryRevision, 3)
  assert.equal(after.frames[0].status, 'ancestor')
  assert.equal(after.frames[0].resolvedFrom, '2026.08.1')
})

test('cancelled in-flight work releases its concurrency slot', async () => {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '2026.08.1' }))
  const cw = controllableWork()
  const resolver = new SymbolResolver(registry, { concurrency: 1, batchWork: cw.work })
  const controller = new AbortController()

  const pending = resolver.resolveBatch(batchRequest({
    requests: [resolveRequest({ version: '2026.08.1' })]
  }), { signal: controller.signal })

  await delay(20)
  controller.abort()
  cw.releaseAll()
  await pending

  const cw2 = controllableWork()
  const resolver2 = new SymbolResolver(registry, { concurrency: 1, batchWork: cw2.work })
  const secondPromise = resolver2.resolveBatch(batchRequest({
    requests: [resolveRequest({ version: '2026.08.1' })]
  }))
  await delay(20)
  assert.equal(cw2.stats().active, 1, 'slot was released, a new job can acquire it')
  cw2.releaseAll()
  const second = await secondPromise
  assert.ok(second.results[0].ok)
})

test('HTTP batch timeout returns per-item cancelled results and releases the server', async (t) => {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '2026.08.1' }))
  const resolver = new SymbolResolver(registry, {
    concurrency: 1,
    batchWork: () => delay(150)
  })
  const server = createApiServer({ registry, resolver, batchTimeoutMs: 40 })
  const baseUrl = await listen(server)
  t.after(() => server.close())

  const response = await fetch(`${baseUrl}/v1/resolve/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(batchRequest({
      requests: [
        resolveRequest({ version: '2026.08.1' }),
        resolveRequest({ version: '2026.08.1', frames: [{ file: 'x.js', line: 1, column: 0 }] })
      ]
    }))
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.ok(body.results.every((r) => !r.ok && r.error.code === 'cancelled'))
})

test('HTTP client disconnect aborts the batch without leaving work running', async (t) => {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '2026.08.1' }))
  let entered = 0
  let completed = 0
  const resolver = new SymbolResolver(registry, {
    concurrency: 2,
    batchWork: async () => {
      entered++
      await delay(100)
      completed++
    }
  })
  const server = createApiServer({ registry, resolver, batchTimeoutMs: 0 })
  const baseUrl = await listen(server)
  t.after(() => server.close())

  const controller = new AbortController()
  const fetchPromise = fetch(`${baseUrl}/v1/resolve/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(batchRequest({
      requests: Array.from({ length: 8 }, () => resolveRequest({ version: '2026.08.1' }))
    })),
    signal: controller.signal
  })

  await delay(30)
  controller.abort()
  await assert.rejects(fetchPromise)

  await delay(150)
  assert.ok(entered <= 2, `no new jobs should start after disconnect, entered=${entered}`)
})
