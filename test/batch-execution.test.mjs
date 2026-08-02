import assert from 'node:assert/strict'
import test from 'node:test'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { SymbolResolver } from '../src/resolver.mjs'
import { bundle, childBundle, lineageChange, resolveRequest } from '../test-support/fixtures.mjs'

const tick = () => new Promise((resolve) => setImmediate(resolve))

async function drain (resolver, gate, body, options) {
  const promise = resolver.resolveBatch(body, options)
  while (gate.pending.length > 0) {
    gate.releaseAll()
    await tick()
  }
  return promise
}

function createGate () {
  const pending = []
  return {
    pending,
    schedule: () => new Promise((resolve) => pending.push(resolve)),
    release (count = 1) {
      for (let step = 0; step < count && pending.length > 0; step += 1) pending.shift()()
    },
    releaseAll () {
      while (pending.length > 0) pending.shift()()
    }
  }
}

function countStarts (resolver) {
  const counter = { starts: 0 }
  const original = resolver.resolveSnapshot.bind(resolver)
  resolver.resolveSnapshot = (...args) => {
    counter.starts += 1
    return original(...args)
  }
  return counter
}

function setupRegistry () {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(childBundle())
  registry.put(bundle({ version: '2026.08.3' }))
  return registry
}

const appJs = { file: 'app.js', line: 10, column: 2 }
const checkoutJs = { file: 'checkout.js', line: 19, column: 0 }

test('caps concurrent resolution work inside one batch', async () => {
  const registry = setupRegistry()
  const gate = createGate()
  const resolver = new SymbolResolver(registry, { batchConcurrency: 2, schedule: gate.schedule })
  const counter = countStarts(resolver)
  const requests = [
    resolveRequest({ frames: [appJs] }),
    resolveRequest({ version: '2026.08.2', frames: [appJs] }),
    resolveRequest({ version: '2026.08.3', frames: [appJs] }),
    resolveRequest({ frames: [checkoutJs] }),
    resolveRequest({ version: '2026.08.2', frames: [checkoutJs] })
  ]
  const promise = resolver.resolveBatch({ requests })
  assert.equal(gate.pending.length, 2)
  assert.equal(counter.starts, 0)

  gate.release(1)
  await tick()
  assert.equal(counter.starts, 1)
  assert.equal(gate.pending.length, 2)

  while (gate.pending.length > 0) {
    gate.releaseAll()
    await tick()
  }
  const result = await promise
  assert.equal(counter.starts, 5)
  assert.deepEqual(result.results.map((entry) => entry.index), [0, 1, 2, 3, 4])
  assert.equal(result.results[0].frames[0].status, 'exact')
  assert.equal(result.results[4].frames[0].status, 'exact')
})

test('merges duplicate stacks into one read per batch and revision', async () => {
  const registry = setupRegistry()
  const resolver = new SymbolResolver(registry, { schedule: () => Promise.resolve() })
  const counter = countStarts(resolver)
  const result = await resolver.resolveBatch({
    requests: [
      resolveRequest({ frames: [appJs] }),
      resolveRequest({ version: '2026.08.2', frames: [appJs] }),
      resolveRequest({ version: '2026.08.3', frames: [appJs] }),
      resolveRequest({ frames: [appJs] }),
      resolveRequest({ version: '2026.08.2', frames: [appJs] }),
      resolveRequest({ version: '2026.08.2', frames: [appJs] })
    ]
  })
  assert.equal(counter.starts, 3)
  assert.deepEqual(result.results.map((entry) => entry.index), [0, 1, 2, 3, 4, 5])
  assert.deepEqual(result.results[0].frames, result.results[3].frames)
  assert.deepEqual(result.results[1].frames, result.results[4].frames)
  assert.deepEqual(result.results[1].frames, result.results[5].frames)
  assert.notEqual(result.results[0].frames, result.results[3].frames)
  result.results[0].frames[0].source.file = 'mutated.ts'
  assert.equal(result.results[3].frames[0].source.file, 'src/bootstrap.ts')
})

test('keeps per-item errors located while deduplicating valid reads', async () => {
  const registry = setupRegistry()
  const resolver = new SymbolResolver(registry, { schedule: () => Promise.resolve() })
  const counter = countStarts(resolver)
  const result = await resolver.resolveBatch({
    requests: [
      resolveRequest({ frames: [appJs] }),
      { application: 'mobile-shell', platform: 'android', version: '2026.08.1', frames: 'nope' },
      resolveRequest({ frames: [appJs] }),
      resolveRequest({ version: '2026.09.9' }),
      resolveRequest({ version: '2026.08.2', frames: [appJs] })
    ]
  })
  assert.equal(counter.starts, 3)
  assert.deepEqual(result.results.map((entry) => entry.index), [0, 1, 2, 3, 4])
  assert.equal(result.results[0].frames[0].status, 'exact')
  assert.deepEqual(result.results[0].frames, result.results[2].frames)
  assert.equal(result.results[1].error, 'invalid_frames')
  assert.equal(result.results[1].index, 1)
  assert.equal(result.results[3].error, 'bundle_not_found')
  assert.equal(result.results[4].frames[0].status, 'unmapped')
})

test('stops starting new work and cleans up after cancellation', async () => {
  const registry = setupRegistry()
  const gate = createGate()
  const resolver = new SymbolResolver(registry, { batchConcurrency: 1, schedule: gate.schedule })
  const counter = countStarts(resolver)
  const controller = new AbortController()
  const promise = resolver.resolveBatch({
    requests: [
      resolveRequest({ frames: [appJs] }),
      resolveRequest({ version: '2026.08.2', frames: [appJs] }),
      resolveRequest({ version: '2026.08.3', frames: [appJs] }),
      resolveRequest({ frames: [checkoutJs] })
    ]
  }, { signal: controller.signal })
  assert.equal(gate.pending.length, 1)
  controller.abort()
  await assert.rejects(
    promise,
    (error) => error.statusCode === 408 && error.code === 'batch_aborted'
  )
  assert.equal(counter.starts, 0)
  gate.releaseAll()
  await tick()
  await tick()
  assert.equal(counter.starts, 0)

  const recovered = await drain(resolver, gate, { requests: [resolveRequest()] })
  assert.equal(recovered.results[0].frames[0].status, 'exact')
})

test('rejects a batch whose signal is already aborted or times out', async () => {
  const registry = setupRegistry()
  const gate = createGate()
  const resolver = new SymbolResolver(registry, { schedule: gate.schedule })
  const counter = countStarts(resolver)
  await assert.rejects(
    resolver.resolveBatch({ requests: [resolveRequest()] }, { signal: AbortSignal.abort() }),
    (error) => error.code === 'batch_aborted'
  )
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25)
  await assert.rejects(
    resolver.resolveBatch({ requests: [resolveRequest()] }, { signal: controller.signal }),
    (error) => error.code === 'batch_aborted'
  )
  clearTimeout(timer)
  gate.releaseAll()
  await tick()
  assert.equal(counter.starts, 0)
})

test('keeps a slow batch on its snapshot while lineage changes commit around it', async () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(childBundle())
  registry.applyLineage({ revision: 2, changes: [lineageChange()] })
  const gate = createGate()
  const resolver = new SymbolResolver(registry, { schedule: gate.schedule })
  const request = () => resolveRequest({ version: '2026.08.2', frames: [appJs, checkoutJs] })

  const slow = resolver.resolveBatch({ requests: [request(), request()] })
  assert.equal(gate.pending.length, 1)

  registry.applyLineage({ revision: 3, changes: [lineageChange({ parent: null })] })
  assert.equal(registry.stats().revision, 4)

  gate.releaseAll()
  const during = await slow
  assert.equal(during.registryRevision, 3)
  assert.equal(during.results[0].frames[0].status, 'ancestor')
  assert.equal(during.results[0].frames[0].resolvedFrom, '2026.08.1')
  assert.deepEqual(during.results[1].frames, during.results[0].frames)

  const fresh = await drain(resolver, gate, { requests: [request()] })
  assert.equal(fresh.registryRevision, 4)
  assert.equal(fresh.results[0].frames[0].status, 'unmapped')

  registry.rollbackLineage({ revision: 4, target: 4 })
  const restored = await drain(resolver, gate, { requests: [request()] })
  assert.equal(restored.registryRevision, 5)
  assert.equal(restored.results[0].frames[0].status, 'ancestor')
  assert.equal(restored.results[0].frames[0].resolvedFrom, '2026.08.1')
})
