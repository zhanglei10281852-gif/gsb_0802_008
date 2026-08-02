import assert from 'node:assert/strict'
import test from 'node:test'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { ApiError } from '../src/errors.mjs'
import { SymbolResolver } from '../src/resolver.mjs'
import { bundle, lineageRequest, resolveRequest } from '../test-support/fixtures.mjs'

const tick = () => new Promise((resolve) => setImmediate(resolve))

function seededRegistry () {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(bundle({
    version: '2026.08.2',
    mappings: [{
      generated: { file: 'hotfix.js', line: 1, column: 0 },
      source: { file: 'src/hotfix.ts', line: 5, column: 2 }
    }]
  }))
  registry.applyLineage(lineageRequest({ expectedRevision: 2 }))
  return registry
}

function manyItems (count) {
  return Array.from({ length: count }, (_, i) => resolveRequest({
    frames: [{ file: 'app.js', line: 10, column: 2 + i }]
  }))
}

test('runs no more than maxConcurrency resolutions at once', async () => {
  const resolver = new SymbolResolver(seededRegistry())
  let active = 0
  let peak = 0
  const batch = await resolver.resolveBatch({ items: manyItems(20) }, {
    maxConcurrency: 4,
    beforeResolve: async () => {
      active += 1
      peak = Math.max(peak, active)
      await tick()
      active -= 1
    }
  })
  assert.equal(peak, 4)
  assert.equal(batch.results.length, 20)
  assert.ok(batch.results.every((entry, i) => entry.index === i && entry.ok))
})

test('reuses one resolution read for duplicate items within a batch', async () => {
  const resolver = new SymbolResolver(seededRegistry())
  let reads = 0
  const duplicate = resolveRequest({ frames: [{ file: 'app.js', line: 10, column: 2 }] })
  const batch = await resolver.resolveBatch({ items: [duplicate, duplicate, duplicate] }, {
    beforeResolve: async () => { reads += 1 }
  })
  // Three identical items share a single actual read.
  assert.equal(reads, 1)
  // But each duplicate still gets its own locatable, independent result.
  assert.equal(batch.results.length, 3)
  assert.deepEqual(batch.results.map((entry) => entry.index), [0, 1, 2])
  batch.results[0].frames[0].source.file = 'mutated.ts'
  assert.notEqual(batch.results[1].frames[0].source.file, 'mutated.ts')
})

test('stops starting new work once cancelled and releases batch reads', async () => {
  const resolver = new SymbolResolver(seededRegistry())
  const controller = new AbortController()
  let started = 0
  const promise = resolver.resolveBatch({ items: manyItems(30) }, {
    signal: controller.signal,
    maxConcurrency: 2,
    beforeResolve: async () => {
      started += 1
      if (started === 2) controller.abort()
      await tick()
    }
  })
  await assert.rejects(promise, (error) => error instanceof ApiError && error.code === 'request_cancelled')
  // Only the in-flight items ran; the pool did not start all 30.
  assert.ok(started < 30, `expected cancellation to stop new work, but ${started} started`)
})

test('cancelling before any work returns immediately without resolving', async () => {
  const resolver = new SymbolResolver(seededRegistry())
  const controller = new AbortController()
  controller.abort()
  let started = 0
  await assert.rejects(
    resolver.resolveBatch({ items: manyItems(5) }, {
      signal: controller.signal,
      beforeResolve: async () => { started += 1 }
    }),
    (error) => error instanceof ApiError && error.code === 'request_cancelled'
  )
  assert.equal(started, 0)
})

test('a batch stays pinned to its snapshot while lineage changes concurrently', async () => {
  const registry = seededRegistry()
  const resolver = new SymbolResolver(registry)
  let switched = false
  const promise = resolver.resolveBatch({
    items: [
      resolveRequest({ version: '2026.08.2', frames: [{ file: 'app.js', line: 10, column: 2 }] }),
      resolveRequest({ version: '2026.08.2', frames: [{ file: 'app.js', line: 10, column: 2 }] })
    ]
  }, {
    maxConcurrency: 1,
    beforeResolve: async () => {
      // Roll back the lineage mid-batch; the in-flight batch must not see it.
      if (!switched) {
        registry.rollbackLineage({ application: 'mobile-shell', platform: 'android', expectedRevision: 3, toRevision: 2 })
        switched = true
      }
      await tick()
    }
  })
  const batch = await promise
  assert.equal(batch.registryRevision, 3)
  assert.ok(batch.results.every((entry) => entry.frames[0].status === 'ancestor'))

  // A request that starts after the switch sees the new revision, where the
  // ancestor edge is gone.
  const after = await resolver.resolveBatch({
    items: [resolveRequest({ version: '2026.08.2', frames: [{ file: 'app.js', line: 10, column: 2 }] })]
  })
  assert.equal(after.registryRevision, 4)
  assert.equal(after.results[0].frames[0].status, 'unmapped')
})
