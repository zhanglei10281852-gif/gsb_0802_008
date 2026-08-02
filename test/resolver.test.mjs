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

  registry.put(bundle({
    version: '2026.08.1-hotfix1',
    parentVersion: '2026.08.1',
    mappings: [{
      generated: { file: 'app.js', line: 10, column: 2 },
      source: { file: 'src/replaced.ts', line: 7, column: 1 }
    }]
  }))
  const afterWrite = resolver.resolve(resolveRequest({ version: '2026.08.1-hotfix1' }))
  assert.equal(afterWrite.registryRevision, 2)
  assert.equal(afterWrite.frames[0].source.file, 'src/replaced.ts')
})

test('falls back through declared lineage when the exact release lacks a mapping', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(bundle({
    version: '2026.08.1-hotfix1',
    parentVersion: '2026.08.1',
    mappings: [{
      generated: { file: 'hotfix.js', line: 1, column: 0 },
      source: { file: 'src/hotfix.ts', line: 9, column: 2 }
    }]
  }))
  const result = new SymbolResolver(registry).resolve(resolveRequest({
    version: '2026.08.1-hotfix1',
    frames: [
      { file: 'hotfix.js', line: 1, column: 0 },
      { file: 'app.js', line: 10, column: 2 },
      { file: 'missing.js', line: 1, column: 0 }
    ]
  }))
  assert.equal(result.registryRevision, 2)
  assert.equal(result.frames[0].status, 'exact')
  assert.equal(result.frames[0].resolvedFrom, '2026.08.1-hotfix1')
  assert.equal(result.frames[1].status, 'ancestor')
  assert.equal(result.frames[1].resolvedFrom, '2026.08.1')
  assert.equal(result.frames[2].status, 'unmapped')
  assert.equal(result.frames[2].resolvedFrom, null)
})

test('does not cross application or platform boundaries while walking ancestors', () => {
  const registry = new BundleRegistry()
  registry.put(bundle({ application: 'other-shell', platform: 'android', version: '2026.08.1' }))
  assert.throws(
    () => registry.put(bundle({
      application: 'mobile-shell',
      platform: 'android',
      version: '2026.08.1-hotfix1',
      parentVersion: '2026.08.1'
    })),
    (error) => error instanceof ApiError && error.code === 'parent_release_not_found'
  )

  const crossPlatform = new BundleRegistry()
  crossPlatform.put(bundle({ application: 'mobile-shell', platform: 'ios', version: '2026.08.1' }))
  assert.throws(
    () => crossPlatform.put(bundle({
      application: 'mobile-shell',
      platform: 'android',
      version: '2026.08.1-hotfix1',
      parentVersion: '2026.08.1'
    })),
    (error) => error instanceof ApiError && error.code === 'parent_release_not_found'
  )
})

test('resolveBatch shares one immutable snapshot and isolates per-item errors', async () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(bundle({
    version: '2026.08.2',
    mappings: [{
      generated: { file: 'other.js', line: 1, column: 0 },
      source: { file: 'src/other.ts', line: 1, column: 0 }
    }]
  }))
  const resolver = new SymbolResolver(registry)
  const result = await resolver.resolveBatch({ items: [
    resolveRequest({ frames: [{ file: 'app.js', line: 10, column: 2 }] }),
    resolveRequest({ version: 'missing-version' }),
    { application: 'mobile-shell', platform: 'android', version: '2026.08.2', frames: [] },
    resolveRequest({
      version: '2026.08.2',
      frames: [{ file: 'app.js', line: 10, column: 2 }]
    })
  ] })
  assert.equal(result.registryRevision, 2)
  assert.equal(result.results.length, 4)
  assert.equal(result.results[0].index, 0)
  assert.equal(result.results[0].frames[0].status, 'exact')
  assert.equal(result.results[1].index, 1)
  assert.equal(result.results[1].error.code, 'bundle_not_found')
  assert.equal(result.results[2].index, 2)
  assert.equal(result.results[2].error.code, 'invalid_frames')
  assert.equal(result.results[3].index, 3)
  assert.equal(result.results[3].frames[0].status, 'unmapped')
})
