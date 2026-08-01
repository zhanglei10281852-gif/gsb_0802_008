import assert from 'node:assert/strict'
import test from 'node:test'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { createApiServer } from '../src/http.mjs'
import { SymbolResolver } from '../src/resolver.mjs'
import { bundle, listen, resolveRequest } from '../test-support/fixtures.mjs'

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
