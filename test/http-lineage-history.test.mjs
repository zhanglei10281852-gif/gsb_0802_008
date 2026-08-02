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

function freshServer (options) {
  const registry = new BundleRegistry(options)
  const server = createApiServer({ registry, resolver: new SymbolResolver(registry) })
  return { registry, server }
}

const base = { application: 'mobile-shell', platform: 'android' }

async function seedChain (baseUrl) {
  await postJson(baseUrl, '/v1/bundles', bundle({ version: '1.0.0' }))
  await postJson(baseUrl, '/v1/bundles', bundle({
    version: '1.1.0',
    parentVersion: '1.0.0',
    mappings: [{
      generated: { file: 'patch.js', line: 1, column: 0 },
      source: { file: 'src/patch.ts', line: 1, column: 0 }
    }]
  }))
  await postJson(baseUrl, '/v1/bundles', bundle({
    version: '1.2.0',
    parentVersion: '1.1.0',
    mappings: [{
      generated: { file: 'patch2.js', line: 1, column: 0 },
      source: { file: 'src/patch2.ts', line: 1, column: 0 }
    }]
  }))
}

test('POST /v1/lineage/preview reports impact without changing revision', async (t) => {
  const { server, registry } = freshServer()
  const baseUrl = await listen(server)
  t.after(() => server.close())
  await seedChain(baseUrl)

  const preview = await postJson(baseUrl, '/v1/lineage/preview', {
    expectedRevision: 3,
    changes: [{ ...base, version: '1.2.0', parentVersion: '1.0.0' }]
  })
  assert.equal(preview.response.status, 200)
  assert.equal(preview.body.valid, true)
  assert.equal(preview.body.currentRevision, 3)
  assert.deepEqual(preview.body.affectedReleases.map((r) => r.version), ['1.2.0'])
  assert.equal(registry.stats().revision, 3)

  const rejected = await postJson(baseUrl, '/v1/lineage/preview', {
    changes: [{ ...base, version: '1.2.0', parentVersion: '9.9.9' }]
  })
  assert.equal(rejected.response.status, 200)
  assert.equal(rejected.body.valid, false)
  assert.equal(rejected.body.errors[0].code, 'unknown_parent_release')
})

test('POST /v1/lineage apply then rollback over HTTP, resolving on the new revision', async (t) => {
  const { server } = freshServer()
  const baseUrl = await listen(server)
  t.after(() => server.close())
  await seedChain(baseUrl)

  const applied = await postJson(baseUrl, '/v1/lineage', {
    expectedRevision: 3,
    changes: [{ ...base, version: '1.2.0', parentVersion: '1.0.0' }]
  })
  assert.equal(applied.response.status, 200)
  assert.equal(applied.body.revision, 4)

  const reparented = await postJson(baseUrl, '/v1/resolve', resolveRequest({
    version: '1.2.0',
    frames: [{ file: 'patch.js', line: 1, column: 0 }]
  }))
  assert.equal(reparented.body.frames[0].status, 'unmapped')

  const rollbackPreview = await postJson(baseUrl, '/v1/lineage/rollback', {
    expectedRevision: 4,
    toRevision: 3
  })
  assert.equal(rollbackPreview.response.status, 200)

  const restored = await postJson(baseUrl, '/v1/lineage/rollback', {
    expectedRevision: 4,
    toRevision: 3
  })
  assert.equal(restored.response.status, 200)
  assert.equal(restored.body.revision, 5)
  assert.equal(restored.body.targetRevision, 3)

  const recovered = await postJson(baseUrl, '/v1/resolve', resolveRequest({
    version: '1.2.0',
    frames: [{ file: 'patch.js', line: 1, column: 0 }]
  }))
  assert.equal(recovered.body.frames[0].status, 'ancestor')
  assert.equal(recovered.body.frames[0].resolvedFrom, '1.1.0')
})

test('rollback over HTTP rejects stale callers and revisions outside history', async (t) => {
  const { server } = freshServer({ historyLimit: 3 })
  const baseUrl = await listen(server)
  t.after(() => server.close())
  await postJson(baseUrl, '/v1/bundles', bundle({ version: '1.0.0' }))
  await postJson(baseUrl, '/v1/bundles', bundle({ version: '1.1.0', parentVersion: '1.0.0' }))
  await postJson(baseUrl, '/v1/bundles', bundle({ version: '1.2.0', parentVersion: '1.1.0' }))

  const stale = await postJson(baseUrl, '/v1/lineage/rollback', { expectedRevision: 1, toRevision: 2 })
  assert.equal(stale.response.status, 409)
  assert.equal(stale.body.error, 'revision_conflict')

  const forgotten = await postJson(baseUrl, '/v1/lineage/rollback', { toRevision: 1 })
  assert.equal(forgotten.response.status, 409)
  assert.equal(forgotten.body.error, 'revision_not_in_history')
})

test('a snapshot captured before a lineage switch completes against its own immutable view', async (t) => {
  const { server, registry } = freshServer()
  const baseUrl = await listen(server)
  t.after(() => server.close())
  await seedChain(baseUrl)

  const resolver = new SymbolResolver(registry)
  const snapshot = registry.snapshot()
  assert.equal(snapshot.revision, 3)

  await postJson(baseUrl, '/v1/lineage', {
    expectedRevision: 3,
    changes: [{ ...base, version: '1.2.0', parentVersion: '1.0.0' }]
  })

  const beforeSwitch = resolver.resolveSnapshot({
    identity: { ...base, version: '1.2.0' },
    frames: [{ file: 'patch.js', line: 1, column: 0 }],
    snapshot
  })
  assert.equal(beforeSwitch.registryRevision, 3)
  assert.equal(beforeSwitch.frames[0].status, 'ancestor')
  assert.equal(beforeSwitch.frames[0].resolvedFrom, '1.1.0')

  const afterSwitch = await postJson(baseUrl, '/v1/resolve', resolveRequest({
    version: '1.2.0',
    frames: [{ file: 'patch.js', line: 1, column: 0 }]
  }))
  assert.equal(afterSwitch.body.registryRevision, 4)
  assert.equal(afterSwitch.body.frames[0].status, 'unmapped')
})
