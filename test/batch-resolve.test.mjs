import assert from 'node:assert/strict'
import test from 'node:test'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { SymbolResolver } from '../src/resolver.mjs'
import { batchRequest, bundle, resolveRequest } from '../test-support/fixtures.mjs'

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

test('resolves a batch against a single immutable snapshot in input order', async () => {
  const registry = populatedRegistry()
  const resolver = new SymbolResolver(registry)
  const result = await resolver.resolveBatch(batchRequest({
    requests: [
      resolveRequest({ version: '2026.08.2', frames: [{ file: 'app.js', line: 10, column: 2 }] }),
      resolveRequest({ version: '2026.08.2', frames: [{ file: 'new.js', line: 1, column: 0 }] })
    ]
  }))
  assert.equal(result.registryRevision, 2)
  assert.equal(result.results.length, 2)
  assert.equal(result.results[0].index, 0)
  assert.equal(result.results[0].ok, true)
  assert.equal(result.results[0].frames[0].status, 'ancestor')
  assert.equal(result.results[0].frames[0].resolvedFrom, '2026.08.1')
  assert.equal(result.results[1].index, 1)
  assert.equal(result.results[1].ok, true)
  assert.equal(result.results[1].frames[0].status, 'exact')
})

test('isolates per-item failures without dropping sibling results', async () => {
  const registry = populatedRegistry()
  const resolver = new SymbolResolver(registry)
  const result = await resolver.resolveBatch(batchRequest({
    requests: [
      resolveRequest({ version: '2026.08.2' }),
      resolveRequest({ version: '9.9.9' }),
      { application: 'mobile-shell', platform: 'android', version: '2026.08.2', frames: [] },
      resolveRequest({ version: '2026.08.1' })
    ]
  }))
  assert.equal(result.registryRevision, 2)
  assert.equal(result.results[0].ok, true)
  assert.equal(result.results[1].ok, false)
  assert.equal(result.results[1].index, 1)
  assert.equal(result.results[1].error.code, 'bundle_not_found')
  assert.equal(result.results[2].ok, false)
  assert.equal(result.results[2].error.code, 'invalid_frames')
  assert.equal(result.results[3].ok, true)
  assert.equal(result.results[3].frames[0].status, 'exact')
})

test('shares one snapshot across the whole batch so later items cannot see newer revisions', async () => {
  const registry = populatedRegistry()
  const resolver = new SymbolResolver(registry)
  const result = await resolver.resolveBatch(batchRequest({
    requests: [
      resolveRequest({ version: '2026.08.2' }),
      resolveRequest({ version: '2026.08.99' })
    ]
  }))
  registry.put(bundle({ version: '2026.08.99', mappings: [bundle().mappings[0]] }))
  assert.equal(result.registryRevision, 2)
  assert.equal(result.results[1].ok, false)
  assert.equal(result.results[1].error.code, 'bundle_not_found')
})

test('rejects a batch payload without a requests array', async () => {
  const registry = populatedRegistry()
  const resolver = new SymbolResolver(registry)
  await assert.rejects(
    () => resolver.resolveBatch({}),
    (error) => error.code === 'invalid_requests'
  )
})

test('localizes non-object batch items to their index', async () => {
  const registry = populatedRegistry()
  const resolver = new SymbolResolver(registry)
  const result = await resolver.resolveBatch({ requests: [null, resolveRequest({ version: '2026.08.1' })] })
  assert.equal(result.results[0].ok, false)
  assert.equal(result.results[0].error.code, 'invalid_request')
  assert.equal(result.results[1].ok, true)
})
