import assert from 'node:assert/strict'
import test from 'node:test'
import { BatchLeaseManager } from '../src/batch-lease-manager.mjs'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { createApiServer } from '../src/http.mjs'
import { SymbolResolver } from '../src/resolver.mjs'
import { bundle, listen, resolveRequest } from '../test-support/fixtures.mjs'

async function postJson (baseUrl, path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  })
  return { response, body: await response.json() }
}

function freshServer () {
  const leaseManager = new BatchLeaseManager()
  const registry = new BundleRegistry({ leaseManager })
  const resolver = new SymbolResolver(registry, { leaseManager })
  const server = createApiServer({ registry, resolver })
  return { leaseManager, registry, resolver, server }
}

test('POST /v1/gc/preview reports retained digests across current releases, history and batches', async (t) => {
  const { server } = freshServer()
  const baseUrl = await listen(server)
  t.after(() => server.close())
  await postJson(baseUrl, '/v1/bundles', bundle({ version: '1.0.0' }))
  await postJson(baseUrl, '/v1/bundles', bundle({ version: '1.1.0', parentVersion: '1.0.0' }))

  const preview = await postJson(baseUrl, '/v1/gc/preview')
  assert.equal(preview.response.status, 200)
  assert.equal(preview.body.currentRevision, 2)
  assert.equal(preview.body.reclaimable.length, 0)
  assert.equal(preview.body.retained.currentReleaseDigestCount, 1)
  assert.equal(preview.body.retained.historyWindowDigestCount, 1)
  assert.equal(preview.body.retained.activeBatchCount, 0)
})

test('POST /v1/gc refuses a stale expectedRevision over HTTP', async (t) => {
  const { server } = freshServer()
  const baseUrl = await listen(server)
  t.after(() => server.close())
  await postJson(baseUrl, '/v1/bundles', bundle({ version: '1.0.0' }))

  const conflict = await postJson(baseUrl, '/v1/gc', { expectedRevision: 99 })
  assert.equal(conflict.response.status, 409)
  assert.equal(conflict.body.error, 'gc_revision_conflict')
})

test('an in-flight batch keeps its artifacts protected from GC over HTTP', async (t) => {
  const leaseManager = new BatchLeaseManager()
  const registry = new BundleRegistry({ leaseManager })
  let releaseWork
  const resolver = new SymbolResolver(registry, {
    leaseManager,
    executeWork: ({ resolve }) => new Promise((workResolve) => {
      releaseWork = () => workResolve(resolve())
    })
  })
  const server = createApiServer({ registry, resolver })
  const baseUrl = await listen(server)
  t.after(() => server.close())
  await postJson(baseUrl, '/v1/bundles', bundle({ version: '1.0.0' }))

  const batchPromise = postJson(baseUrl, '/v1/resolve/batch', {
    items: [resolveRequest({ version: '1.0.0' })],
    concurrency: 1
  })
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    const probe = await postJson(baseUrl, '/v1/gc/preview')
    if (probe.body.retained.activeBatchCount === 1) break
  }

  const protectedPreview = await postJson(baseUrl, '/v1/gc/preview')
  assert.equal(protectedPreview.body.retained.activeBatchCount, 1)
  assert.equal(protectedPreview.body.reclaimable.length, 0)

  releaseWork()
  const batchResult = await batchPromise
  assert.equal(batchResult.response.status, 200)

  const afterRelease = await postJson(baseUrl, '/v1/gc/preview')
  assert.equal(afterRelease.body.retained.activeBatchCount, 0)
})

test('GC does not affect exact or ancestor resolution after it runs', async (t) => {
  const { server, registry } = freshServer()
  const baseUrl = await listen(server)
  t.after(() => server.close())
  await postJson(baseUrl, '/v1/bundles', bundle({ version: '1.0.0' }))
  await postJson(baseUrl, '/v1/bundles', bundle({
    version: '1.1.0',
    parentVersion: '1.0.0',
    mappings: [{
      generated: { file: 'patch.js', line: 1, column: 0 },
      source: { file: 'src/patch.ts', line: 1, column: 0 }
    }]
  }))

  const gc = await postJson(baseUrl, '/v1/gc', { expectedRevision: 2 })
  assert.equal(gc.response.status, 200)
  assert.equal(gc.body.reclaimed, 0)

  const exact = await postJson(baseUrl, '/v1/resolve', resolveRequest({ version: '1.0.0' }))
  assert.equal(exact.body.frames[0].status, 'exact')
  const ancestor = await postJson(baseUrl, '/v1/resolve', resolveRequest({
    version: '1.1.0',
    frames: [{ file: 'app.js', line: 10, column: 2 }]
  }))
  assert.equal(ancestor.body.frames[0].status, 'ancestor')
  assert.equal(ancestor.body.frames[0].resolvedFrom, '1.0.0')
})
