import assert from 'node:assert/strict'
import test from 'node:test'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { ResolutionCancelledError, SymbolResolver } from '../src/resolver.mjs'
import { bundle, resolveRequest } from '../test-support/fixtures.mjs'

const baseIdentity = { application: 'mobile-shell', platform: 'android' }
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function trackingResolver (registry) {
  const started = []
  let active = 0
  let maxActive = 0
  const resolver = new SymbolResolver(registry, {
    async executeWork ({ identity, frames, snapshot, resolve, signal }) {
      const id = `${identity.version}:${frames.map((f) => f.file).join(',')}`
      started.push(id)
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        await delay(20)
        if (signal?.aborted) throw new ResolutionCancelledError(signal.reason)
        return resolve()
      } finally {
        active -= 1
      }
    }
  })
  return { resolver, started, getMaxActive: () => maxActive }
}

test('resolveBatch enforces the concurrency cap for real work', async () => {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '1.0.0' }))
  const { resolver, getMaxActive } = trackingResolver(registry)
  const items = Array.from({ length: 12 }, (_, i) =>
    resolveRequest({ version: '1.0.0', frames: [{ file: `f${i}.js`, line: 1, column: 0 }] })
  )
  const result = await resolver.resolveBatch({ items, concurrency: 3 })
  assert.equal(result.results.length, 12)
  assert.equal(getMaxActive(), 3)
})

test('resolveBatch deduplicates identical reads within one revision', async () => {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '2026.08.1' }))
  const { resolver, started } = trackingResolver(registry)
  const request = resolveRequest({ version: '2026.08.1', frames: [{ file: 'app.js', line: 10, column: 2 }] })
  const result = await resolver.resolveBatch({ items: [request, request, request], concurrency: 4 })
  assert.equal(result.results.length, 3)
  assert.equal(started.length, 1)
  for (let i = 0; i < 3; i += 1) {
    assert.equal(result.results[i].index, i)
    assert.equal(result.results[i].frames[0].status, 'exact')
  }
  result.results[0].frames[0].source.file = 'mutated.ts'
  assert.equal(result.results[1].frames[0].source.file, 'src/bootstrap.ts')
})

test('resolveBatch stops starting new work after abort and releases permits', async () => {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '1.0.0' }))
  const { resolver, started } = trackingResolver(registry)
  const items = Array.from({ length: 20 }, (_, i) =>
    resolveRequest({ version: '1.0.0', frames: [{ file: `g${i}.js`, line: 1, column: 0 }] })
  )
  const controller = new AbortController()
  const promise = resolver.resolveBatch({ items, concurrency: 2 }, { signal: controller.signal })
  setTimeout(() => controller.abort(new Error('client_disconnected')), 15)
  await assert.rejects(promise, (error) => error instanceof ResolutionCancelledError)
  assert.ok(started.length <= 6, `expected only in-flight work to start, got ${started.length}`)
})

test('a batch keeps the snapshot captured at start while a lineage change applies concurrently', async () => {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '1.0.0' }))
  registry.put(bundle({
    version: '1.1.0',
    parentVersion: '1.0.0',
    mappings: [{
      generated: { file: 'patched.js', line: 1, column: 0 },
      source: { file: 'src/patched.ts', line: 1, column: 0 }
    }]
  }))

  let resolveBatchWork
  const resolver = new SymbolResolver(registry, {
    executeWork ({ identity, frames, resolve, signal }) {
      return new Promise((workResolve, workReject) => {
        resolveBatchWork = async () => {
          try {
            await delay(5)
            if (signal?.aborted) throw new ResolutionCancelledError(signal.reason)
            workResolve(resolve())
          } catch (error) {
            workReject(error)
          }
        }
      })
    }
  })

  const batchPromise = resolver.resolveBatch({
    items: [resolveRequest({
      version: '1.1.0',
      frames: [{ file: 'app.js', line: 10, column: 2 }]
    })],
    concurrency: 1
  })
  await delay(5)
  registry.adjustLineage({
    expectedRevision: 2,
    changes: [{ ...baseIdentity, version: '1.1.0', parentVersion: null }]
  })
  resolveBatchWork()
  const batchResult = await batchPromise
  assert.equal(batchResult.registryRevision, 2)
  assert.equal(batchResult.results[0].frames[0].status, 'ancestor')
  assert.equal(batchResult.results[0].frames[0].resolvedFrom, '1.0.0')

  const after = resolver.resolve(resolveRequest({
    version: '1.1.0',
    frames: [{ file: 'app.js', line: 10, column: 2 }]
  }))
  assert.equal(after.registryRevision, 3)
  assert.equal(after.frames[0].status, 'unmapped')
})

test('subsequent batches see the new revision after a lineage change', async () => {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '1.0.0' }))
  registry.put(bundle({
    version: '1.1.0',
    parentVersion: '1.0.0',
    mappings: [{
      generated: { file: 'patched.js', line: 1, column: 0 },
      source: { file: 'src/patched.ts', line: 1, column: 0 }
    }]
  }))
  const resolver = new SymbolResolver(registry)
  const before = await resolver.resolveBatch({ items: [resolveRequest({
    version: '1.1.0',
    frames: [{ file: 'app.js', line: 10, column: 2 }]
  })] })
  assert.equal(before.results[0].frames[0].status, 'ancestor')
  registry.adjustLineage({
    expectedRevision: 2,
    changes: [{ ...baseIdentity, version: '1.1.0', parentVersion: null }]
  })
  const after = await resolver.resolveBatch({ items: [resolveRequest({
    version: '1.1.0',
    frames: [{ file: 'app.js', line: 10, column: 2 }]
  })] })
  assert.equal(after.registryRevision, 3)
  assert.equal(after.results[0].frames[0].status, 'unmapped')
})
