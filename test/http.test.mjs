import assert from 'node:assert/strict'
import test from 'node:test'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { createApiServer } from '../src/http.mjs'
import { SymbolResolver } from '../src/resolver.mjs'
import { bundle, batchRequest, lineageRequest, listen, resolveRequest } from '../test-support/fixtures.mjs'

async function startServer (t) {
  const registry = new BundleRegistry()
  const resolver = new SymbolResolver(registry)
  const server = createApiServer({ registry, resolver })
  const baseUrl = await listen(server)
  t.after(() => server.close())
  return { baseUrl }
}

function post (baseUrl, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

test('creates a bundle and resolves it over the HTTP boundary', async (t) => {
  const registry = new BundleRegistry()
  const server = createApiServer({ registry, resolver: new SymbolResolver(registry) })
  const baseUrl = await listen(server)
  t.after(() => server.close())

  const stored = await fetch(`${baseUrl}/v1/bundles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bundle())
  })
  assert.equal(stored.status, 201)
  assert.equal((await stored.json()).mappingCount, 2)

  const resolved = await fetch(`${baseUrl}/v1/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(resolveRequest())
  })
  assert.equal(resolved.status, 200)
  assert.equal((await resolved.json()).frames[0].status, 'exact')
})

test('returns a stable error response for malformed JSON', async (t) => {
  const registry = new BundleRegistry()
  const server = createApiServer({ registry, resolver: new SymbolResolver(registry) })
  const baseUrl = await listen(server)
  t.after(() => server.close())
  const response = await fetch(`${baseUrl}/v1/resolve`, { method: 'POST', body: '{' })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, 'invalid_json')
})

test('declares lineage and resolves an ancestor over the HTTP boundary', async (t) => {
  const { baseUrl } = await startServer(t)
  await post(baseUrl, '/v1/bundles', bundle())
  await post(baseUrl, '/v1/bundles', bundle({
    version: '2026.08.2',
    mappings: [{
      generated: { file: 'hotfix.js', line: 1, column: 0 },
      source: { file: 'src/hotfix.ts', line: 5, column: 2 }
    }]
  }))

  const applied = await post(baseUrl, '/v1/lineage', lineageRequest({ expectedRevision: 2 }))
  assert.equal(applied.status, 200)
  assert.equal((await applied.json()).revision, 3)

  const resolved = await post(baseUrl, '/v1/resolve', resolveRequest({
    version: '2026.08.2',
    frames: [{ file: 'app.js', line: 10, column: 2 }]
  }))
  assert.equal(resolved.status, 200)
  const body = await resolved.json()
  assert.equal(body.registryRevision, 3)
  assert.equal(body.frames[0].status, 'ancestor')
  assert.equal(body.frames[0].resolvedFrom, '2026.08.1')
})

test('rejects a lineage batch on a stale expected revision', async (t) => {
  const { baseUrl } = await startServer(t)
  await post(baseUrl, '/v1/bundles', bundle())
  await post(baseUrl, '/v1/bundles', bundle({ version: '2026.08.2' }))
  const conflict = await post(baseUrl, '/v1/lineage', lineageRequest({ expectedRevision: 1 }))
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).error, 'revision_conflict')
})

test('resolves a batch over the HTTP boundary and isolates bad items', async (t) => {
  const { baseUrl } = await startServer(t)
  await post(baseUrl, '/v1/bundles', bundle())

  const response = await post(baseUrl, '/v1/resolve/batch', batchRequest({
    items: [
      resolveRequest(),
      resolveRequest({ platform: 'ios' })
    ]
  }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.registryRevision, 1)
  assert.equal(body.results[0].ok, true)
  assert.equal(body.results[0].index, 0)
  assert.equal(body.results[0].frames[0].status, 'exact')
  assert.equal(body.results[1].ok, false)
  assert.equal(body.results[1].index, 1)
  assert.equal(body.results[1].error, 'bundle_not_found')
})
