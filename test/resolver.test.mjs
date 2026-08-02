import assert from 'node:assert/strict'
import test from 'node:test'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { ResolutionCache } from '../src/resolution-cache.mjs'
import { SymbolResolver } from '../src/resolver.mjs'
import { ApiError } from '../src/errors.mjs'
import { bundle, resolveRequest } from '../test-support/fixtures.mjs'

test('resolves exact source positions and keeps unmapped frames explicit', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  const result = new SymbolResolver(registry).resolve(resolveRequest({ frames: [
    { file: 'app.js', line: 10, column: 2 },
    { file: 'app.js', line: 11, column: 2 }
  ] }))
  assert.equal(result.registryRevision, 1)
  assert.deepEqual(result.frames[0], {
    generated: { file: 'app.js', line: 10, column: 2 },
    status: 'exact',
    source: { file: 'src/bootstrap.ts', line: 42, column: 4 },
    resolvedFrom: '2026.08.1'
  })
  assert.equal(result.frames[1].status, 'unmapped')
})

test('does not resolve a request against a different application or platform', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  const resolver = new SymbolResolver(registry)
  assert.throws(
    () => resolver.resolve(resolveRequest({ platform: 'ios' })),
    (error) => error instanceof ApiError && error.code === 'bundle_not_found'
  )
})

test('keeps cached results revision-scoped and detached from callers', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  const resolver = new SymbolResolver(registry, { cache: new ResolutionCache({ limit: 2 }) })
  const first = resolver.resolve(resolveRequest())
  first.frames[0].source.file = 'mutated.ts'
  const second = resolver.resolve(resolveRequest())
  assert.equal(second.frames[0].source.file, 'src/bootstrap.ts')

  registry.put(bundle({ version: '2026.08.2', mappings: [{
    generated: { file: 'app.js', line: 10, column: 2 },
    source: { file: 'src/replaced.ts', line: 7, column: 1 }
  }] }))
  const afterWrite = resolver.resolve(resolveRequest())
  assert.equal(afterWrite.registryRevision, 2)
  assert.equal(afterWrite.frames[0].source.file, 'src/bootstrap.ts')
})
