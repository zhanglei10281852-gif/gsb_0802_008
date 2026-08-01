import assert from 'node:assert/strict'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { createApiServer } from '../src/http.mjs'
import { SymbolResolver } from '../src/resolver.mjs'
import { bundle, listen, resolveRequest } from '../test-support/fixtures.mjs'

const registry = new BundleRegistry()
const server = createApiServer({ registry, resolver: new SymbolResolver(registry) })
const baseUrl = await listen(server)

try {
  const stored = await fetch(`${baseUrl}/v1/bundles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bundle())
  })
  assert.equal(stored.status, 201)
  const resolved = await fetch(`${baseUrl}/v1/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(resolveRequest())
  })
  assert.equal(resolved.status, 200)
  assert.equal((await resolved.json()).frames[0].status, 'exact')
  console.log('HTTP smoke check passed')
} finally {
  await new Promise((resolve) => server.close(resolve))
}
