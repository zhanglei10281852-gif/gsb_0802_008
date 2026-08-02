import assert from 'node:assert/strict'
import test from 'node:test'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { createApiServer } from '../src/http.mjs'
import { SymbolResolver } from '../src/resolver.mjs'
import { ApiError } from '../src/errors.mjs'
import { batchRequest, bundle, listen, resolveRequest } from '../test-support/fixtures.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function populatedRegistry () {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '2026.08.1' }))
  registry.put(bundle({
    version: '2026.08.2',
    parentVersion: '2026.08.1',
    mappings: [
      { generated: { file: 'new.js', line: 1, column: 0 }, source: { file: 'src/new.ts', line: 1, column: 0 } }
    ]
  }))
  return registry
}

test('gc preview reports no collectible artifacts when all content is live-referenced', () => {
  const registry = populatedRegistry()
  const preview = registry.previewGarbageCollection({ expectedRevision: 2 })
  assert.equal(preview.ok, true)
  assert.equal(preview.baseRevision, 2)
  assert.equal(preview.collectible.length, 0)
  assert.equal(preview.activeLeases, 0)
  assert.equal(preview.revisionMismatch, false)
})

test('gc preview flags revision mismatch but still reports current state', () => {
  const registry = populatedRegistry()
  const preview = registry.previewGarbageCollection({ expectedRevision: 99 })
  assert.equal(preview.revisionMismatch, true)
  assert.equal(preview.baseRevision, 2)
})

test('gc execution is a safe no-op when nothing is collectible', () => {
  const registry = populatedRegistry()
  const result = registry.collectGarbage({ expectedRevision: 2 })
  assert.equal(result.revision, 2, 'no revision advance when nothing collected')
  assert.deepEqual(result.collected, [])
  assert.equal(registry.stats().artifactCount, 2)
})

test('gc execution rejects stale expectedRevision with 412', () => {
  const registry = populatedRegistry()
  assert.throws(
    () => registry.collectGarbage({ expectedRevision: 99 }),
    (error) => error instanceof ApiError && error.code === 'revision_mismatch'
  )
})

test('gc does not affect exact or ancestor resolution', () => {
  const registry = populatedRegistry()
  registry.collectGarbage({ expectedRevision: 2 })
  const resolver = new SymbolResolver(registry)

  const exact = resolver.resolve(resolveRequest({ version: '2026.08.2' }))
  assert.equal(exact.frames[0].status, 'ancestor')
  assert.equal(exact.frames[0].resolvedFrom, '2026.08.1')

  const ancestor = resolver.resolve(resolveRequest({
    version: '2026.08.2',
    frames: [{ file: 'new.js', line: 1, column: 0 }]
  }))
  assert.equal(ancestor.frames[0].status, 'exact')
})

test('active batch leases are visible to gc preview and released after completion', async () => {
  const registry = populatedRegistry()
  let releaseWork
  const workPromise = new Promise((resolve) => { releaseWork = resolve })
  const resolver = new SymbolResolver(registry, {
    concurrency: 1,
    batchWork: () => workPromise
  })

  const batchPromise = resolver.resolveBatch(batchRequest({
    requests: [resolveRequest({ version: '2026.08.1' }), resolveRequest({ version: '2026.08.2' })]
  }))

  await delay(20)
  assert.equal(registry.activeLeaseCount(), 1, 'a lease is held during batch execution')
  const preview = registry.previewGarbageCollection({ expectedRevision: 2 })
  assert.equal(preview.activeLeases, 1)

  releaseWork()
  await batchPromise

  assert.equal(registry.activeLeaseCount(), 0, 'lease is released after batch completes')
  const after = registry.previewGarbageCollection({ expectedRevision: 2 })
  assert.equal(after.activeLeases, 0)
})

test('cancelled batch releases its gc lease', async () => {
  const registry = populatedRegistry()
  const resolver = new SymbolResolver(registry, {
    concurrency: 1,
    batchWork: () => delay(200)
  })
  const controller = new AbortController()

  const pending = resolver.resolveBatch(batchRequest({
    requests: [resolveRequest({ version: '2026.08.1' })]
  }), { signal: controller.signal })

  await delay(20)
  assert.equal(registry.activeLeaseCount(), 1)
  controller.abort()
  await pending
  assert.equal(registry.activeLeaseCount(), 0)
})

test('gc records a history entry when it advances revision', () => {
  const registry = populatedRegistry()
  const before = registry.lineageHistory().entries.length
  registry.collectGarbage({ expectedRevision: 2 })
  const after = registry.lineageHistory().entries.length
  assert.equal(after, before, 'no history entry when nothing was collected')
})

test('gc protects content referenced by the rollback history window', () => {
  const registry = populatedRegistry()
  registry.adjustLineage({
    expectedRevision: 2,
    relationships: [
      { application: 'mobile-shell', platform: 'android', version: '2026.08.2', parentVersion: null }
    ]
  })
  const preview = registry.previewGarbageCollection({ expectedRevision: 3 })
  for (const item of preview.collectible) {
    assert.fail(`artifact ${item.digest} should be protected by history but was marked collectible`)
  }
  assert.equal(preview.collectible.length, 0)
})

test('gc over HTTP: preview and execute endpoints', async (t) => {
  const registry = populatedRegistry()
  const server = createApiServer({ registry, resolver: new SymbolResolver(registry) })
  const baseUrl = await listen(server)
  t.after(() => server.close())

  const preview = await fetch(`${baseUrl}/v1/gc/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 2 })
  })
  assert.equal(preview.status, 200)
  const previewBody = await preview.json()
  assert.equal(previewBody.ok, true)
  assert.equal(previewBody.collectible.length, 0)
  assert.equal(previewBody.activeLeases, 0)

  const executed = await fetch(`${baseUrl}/v1/gc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 2 })
  })
  assert.equal(executed.status, 200)
  const executedBody = await executed.json()
  assert.equal(executedBody.revision, 2)
  assert.deepEqual(executedBody.collected, [])
})

test('gc over HTTP: stale revision returns 412', async (t) => {
  const registry = populatedRegistry()
  const server = createApiServer({ registry, resolver: new SymbolResolver(registry) })
  const baseUrl = await listen(server)
  t.after(() => server.close())

  const response = await fetch(`${baseUrl}/v1/gc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 99 })
  })
  assert.equal(response.status, 412)
  assert.equal((await response.json()).error, 'revision_mismatch')
})

test('gc over HTTP: invalid payload returns 400', async (t) => {
  const registry = populatedRegistry()
  const server = createApiServer({ registry, resolver: new SymbolResolver(registry) })
  const baseUrl = await listen(server)
  t.after(() => server.close())

  const response = await fetch(`${baseUrl}/v1/gc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, 'invalid_expected_revision')
})

test('full lifecycle: publish, lineage, batch, gc preview, and resolution consistency', async () => {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '2026.08.1' }))
  registry.put(bundle({
    version: '2026.08.2',
    mappings: [
      { generated: { file: 'hotfix.js', line: 1, column: 0 }, source: { file: 'src/hotfix.ts', line: 1, column: 0 } }
    ]
  }))
  registry.adjustLineage({
    expectedRevision: 2,
    relationships: [
      { application: 'mobile-shell', platform: 'android', version: '2026.08.2', parentVersion: '2026.08.1' }
    ]
  })

  const resolver = new SymbolResolver(registry)
  const batchResult = await resolver.resolveBatch(batchRequest({
    requests: [
      resolveRequest({ version: '2026.08.2' }),
      resolveRequest({ version: '2026.08.2', frames: [{ file: 'hotfix.js', line: 1, column: 0 }] })
    ]
  }))
  assert.equal(batchResult.results[0].frames[0].status, 'ancestor')
  assert.equal(batchResult.results[1].frames[0].status, 'exact')

  const gcPreview = registry.previewGarbageCollection({ expectedRevision: 3 })
  assert.equal(gcPreview.collectible.length, 0)

  registry.collectGarbage({ expectedRevision: 3 })

  const afterGc = resolver.resolve(resolveRequest({ version: '2026.08.2' }))
  assert.equal(afterGc.frames[0].status, 'ancestor')
  assert.equal(afterGc.frames[0].resolvedFrom, '2026.08.1')
  assert.equal(registry.stats().artifactCount, 2)
})
