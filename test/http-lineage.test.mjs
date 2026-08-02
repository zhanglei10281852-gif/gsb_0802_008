import assert from 'node:assert/strict'
import test from 'node:test'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { createApiServer } from '../src/http.mjs'
import { SymbolResolver } from '../src/resolver.mjs'
import { bundle, listen, resolveRequest } from '../test-support/fixtures.mjs'

async function postJson (baseUrl, path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  })
  return { response, body: await response.json() }
}

function freshServer () {
  const registry = new BundleRegistry()
  const server = createApiServer({ registry, resolver: new SymbolResolver(registry) })
  return { registry, server }
}

test('publishes a hotfix with a declared parent and resolves through the ancestor', async (t) => {
  const { server } = freshServer()
  const baseUrl = await listen(server)
  t.after(() => server.close())

  const base = await postJson(baseUrl, '/v1/bundles', bundle())
  assert.equal(base.response.status, 201)
  assert.equal(base.body.parentVersion, null)

  const hotfix = await postJson(baseUrl, '/v1/bundles', bundle({
    version: '2026.08.1-hotfix1',
    parentVersion: '2026.08.1',
    mappings: [{
      generated: { file: 'hotfix.js', line: 1, column: 0 },
      source: { file: 'src/hotfix.ts', line: 9, column: 2 }
    }]
  }))
  assert.equal(hotfix.response.status, 201)
  assert.equal(hotfix.body.parentVersion, '2026.08.1')

  const resolved = await postJson(baseUrl, '/v1/resolve', resolveRequest({
    version: '2026.08.1-hotfix1',
    frames: [
      { file: 'hotfix.js', line: 1, column: 0 },
      { file: 'app.js', line: 10, column: 2 },
      { file: 'ghost.js', line: 3, column: 1 }
    ]
  }))
  assert.equal(resolved.response.status, 200)
  assert.equal(resolved.body.registryRevision, 2)
  assert.equal(resolved.body.frames[0].status, 'exact')
  assert.equal(resolved.body.frames[0].resolvedFrom, '2026.08.1-hotfix1')
  assert.equal(resolved.body.frames[1].status, 'ancestor')
  assert.equal(resolved.body.frames[1].resolvedFrom, '2026.08.1')
  assert.equal(resolved.body.frames[2].status, 'unmapped')
  assert.equal(resolved.body.frames[2].resolvedFrom, null)
})

test('rejects re-uploading an existing release over HTTP', async (t) => {
  const { server } = freshServer()
  const baseUrl = await listen(server)
  t.after(() => server.close())
  await postJson(baseUrl, '/v1/bundles', bundle())
  const second = await postJson(baseUrl, '/v1/bundles', bundle())
  assert.equal(second.response.status, 409)
  assert.equal(second.body.error, 'release_already_exists')
})

test('POST /v1/lineage commits an atomic revision-scoped group', async (t) => {
  const { server, registry } = freshServer()
  const baseUrl = await listen(server)
  t.after(() => server.close())
  await postJson(baseUrl, '/v1/bundles', bundle({ version: '1.0.0' }))
  await postJson(baseUrl, '/v1/bundles', bundle({ version: '1.1.0', parentVersion: '1.0.0' }))
  await postJson(baseUrl, '/v1/bundles', bundle({ version: '1.2.0', parentVersion: '1.1.0' }))

  const ok = await postJson(baseUrl, '/v1/lineage', {
    expectedRevision: 3,
    changes: [
      { application: 'mobile-shell', platform: 'android', version: '1.2.0', parentVersion: '1.0.0' }
    ]
  })
  assert.equal(ok.response.status, 200)
  assert.equal(ok.body.applied, 1)
  assert.equal(ok.body.revision, 4)

  const conflict = await postJson(baseUrl, '/v1/lineage', {
    expectedRevision: 3,
    changes: [
      { application: 'mobile-shell', platform: 'android', version: '1.2.0', parentVersion: '1.1.0' }
    ]
  })
  assert.equal(conflict.response.status, 409)
  assert.equal(conflict.body.error, 'revision_conflict')
  assert.equal(registry.stats().revision, 4)
})

test('POST /v1/lineage rolls the whole batch back on a cycle', async (t) => {
  const { server, registry } = freshServer()
  const baseUrl = await listen(server)
  t.after(() => server.close())
  await postJson(baseUrl, '/v1/bundles', bundle({ version: '1.0.0' }))
  await postJson(baseUrl, '/v1/bundles', bundle({ version: '1.1.0', parentVersion: '1.0.0' }))

  const failed = await postJson(baseUrl, '/v1/lineage', {
    changes: [
      { application: 'mobile-shell', platform: 'android', version: '1.0.0', parentVersion: '1.1.0' }
    ]
  })
  assert.equal(failed.response.status, 409)
  assert.equal(failed.body.error, 'lineage_cycle')
  assert.equal(registry.stats().lineageEdgeCount, 1)
})

test('POST /v1/resolve/batch shares one immutable snapshot and isolates item errors', async (t) => {
  const { server } = freshServer()
  const baseUrl = await listen(server)
  t.after(() => server.close())
  await postJson(baseUrl, '/v1/bundles', bundle({ version: '1.0.0' }))
  await postJson(baseUrl, '/v1/bundles', bundle({
    version: '1.1.0',
    parentVersion: '1.0.0',
    mappings: [{
      generated: { file: 'patch.js', line: 1, column: 0 },
      source: { file: 'src/patch.ts', line: 3, column: 0 }
    }]
  }))

  const batch = await postJson(baseUrl, '/v1/resolve/batch', { items: [
    resolveRequest({ version: '1.1.0', frames: [{ file: 'app.js', line: 10, column: 2 }] }),
    resolveRequest({ version: 'missing' }),
    { application: 'mobile-shell', platform: 'android', version: '1.1.0', frames: [] },
    resolveRequest({
      version: '1.1.0',
      frames: [{ file: 'patch.js', line: 1, column: 0 }]
    })
  ] })
  assert.equal(batch.response.status, 200)
  assert.equal(batch.body.registryRevision, 2)
  assert.equal(batch.body.results.length, 4)
  assert.deepEqual(
    batch.body.results.map((r) => [r.index, r.error?.code ?? r.frames[0]?.status]),
    [
      [0, 'ancestor'],
      [1, 'bundle_not_found'],
      [2, 'invalid_frames'],
      [3, 'exact']
    ]
  )
  assert.equal(batch.body.results[0].frames[0].resolvedFrom, '1.0.0')
})

test('single resolve route keeps existing status codes and shape for unmapped frames', async (t) => {
  const { server } = freshServer()
  const baseUrl = await listen(server)
  t.after(() => server.close())
  await postJson(baseUrl, '/v1/bundles', bundle())

  const missing = await postJson(baseUrl, '/v1/resolve', resolveRequest({ version: 'nope' }))
  assert.equal(missing.response.status, 404)
  assert.equal(missing.body.error, 'bundle_not_found')

  const ok = await postJson(baseUrl, '/v1/resolve', resolveRequest({
    frames: [{ file: 'absent.js', line: 1, column: 0 }]
  }))
  assert.equal(ok.response.status, 200)
  assert.equal(ok.body.frames[0].status, 'unmapped')
  assert.equal(ok.body.frames[0].source, null)
  assert.equal(ok.body.frames[0].resolvedFrom, null)
})
