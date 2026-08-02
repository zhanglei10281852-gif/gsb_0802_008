import assert from 'node:assert/strict'
import test from 'node:test'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { ApiError } from '../src/errors.mjs'
import { SymbolResolver } from '../src/resolver.mjs'
import { bundle, lineageRequest, resolveRequest } from '../test-support/fixtures.mjs'

function baseRegistry () {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '2026.08.1' }))
  return registry
}

test('declares a parent at publish time and exposes it on the snapshot', () => {
  const registry = baseRegistry()
  const hotfix = registry.put(bundle({
    version: '2026.08.2',
    parentVersion: '2026.08.1',
    mappings: [bundle().mappings[0]]
  }))
  assert.equal(hotfix.parentVersion, '2026.08.1')
  const snapshot = registry.snapshot()
  assert.equal(snapshot.getBundle({ application: 'mobile-shell', platform: 'android', version: '2026.08.2' }).parentVersion, '2026.08.1')
  assert.deepEqual(snapshot.walkLineage({ application: 'mobile-shell', platform: 'android', version: '2026.08.2' }).map((b) => b.version), ['2026.08.2', '2026.08.1'])
})

test('rejects re-uploading an existing release so lineage cannot be bypassed', () => {
  const registry = baseRegistry()
  assert.throws(
    () => registry.put(bundle({ version: '2026.08.1', mappings: [bundle().mappings[0]] })),
    (error) => error instanceof ApiError && error.code === 'bundle_already_exists'
  )
})

test('rejects an unknown parent at publish time', () => {
  const registry = baseRegistry()
  assert.throws(
    () => registry.put(bundle({ version: '2026.08.2', parentVersion: '9.9.9' })),
    (error) => error instanceof ApiError && error.code === 'unknown_version'
  )
})

test('atomically applies a lineage batch against the expected revision', () => {
  const registry = baseRegistry()
  registry.put(bundle({ version: '2026.08.2', mappings: [bundle().mappings[0]] }))
  const result = registry.adjustLineage(lineageRequest({ expectedRevision: 2 }))
  assert.equal(result.revision, 3)
  assert.equal(result.applied, 1)
  assert.equal(
    registry.snapshot().getParentVersion({ application: 'mobile-shell', platform: 'android', version: '2026.08.2' }),
    '2026.08.1'
  )
})

test('rejects the whole batch when the expected revision does not match', () => {
  const registry = baseRegistry()
  registry.put(bundle({ version: '2026.08.2', mappings: [bundle().mappings[0]] }))
  const before = registry.stats().revision
  assert.throws(
    () => registry.adjustLineage(lineageRequest({ expectedRevision: 99 })),
    (error) => error instanceof ApiError && error.code === 'revision_mismatch'
  )
  assert.equal(registry.stats().revision, before)
  assert.equal(
    registry.snapshot().getParentVersion({ application: 'mobile-shell', platform: 'android', version: '2026.08.2' }),
    null
  )
})

test('rejects unknown child and parent versions without partial application', () => {
  const registry = baseRegistry()
  registry.put(bundle({ version: '2026.08.2', mappings: [bundle().mappings[0]] }))
  assert.throws(
    () => registry.adjustLineage(lineageRequest({
      expectedRevision: 2,
      relationships: [
        { application: 'mobile-shell', platform: 'android', version: '2026.08.2', parentVersion: '2026.08.1' },
        { application: 'mobile-shell', platform: 'android', version: '9.9.9', parentVersion: '2026.08.1' }
      ]
    })),
    (error) => error instanceof ApiError && error.code === 'unknown_version'
  )
  assert.equal(
    registry.snapshot().getParentVersion({ application: 'mobile-shell', platform: 'android', version: '2026.08.2' }),
    null
  )
})

test('rejects cross-boundary parent references', () => {
  const registry = baseRegistry()
  registry.put(bundle({ version: '2026.08.2', platform: 'ios', mappings: [bundle().mappings[0]] }))
  assert.throws(
    () => registry.adjustLineage({
      expectedRevision: 2,
      relationships: [
        { application: 'mobile-shell', platform: 'ios', version: '2026.08.2', parentVersion: '2026.08.1' }
      ]
    }),
    (error) => error instanceof ApiError && error.code === 'cross_boundary_reference'
  )
})

test('rejects duplicate children within a single batch', () => {
  const registry = baseRegistry()
  registry.put(bundle({ version: '2026.08.2', mappings: [bundle().mappings[0]] }))
  assert.throws(
    () => registry.adjustLineage({
      expectedRevision: 2,
      relationships: [
        { application: 'mobile-shell', platform: 'android', version: '2026.08.2', parentVersion: '2026.08.1' },
        { application: 'mobile-shell', platform: 'android', version: '2026.08.2', parentVersion: null }
      ]
    }),
    (error) => error instanceof ApiError && error.code === 'duplicate_relationship'
  )
})

test('rejects a cycle and rolls back every relationship in the batch', () => {
  const registry = baseRegistry()
  registry.put(bundle({ version: '2026.08.2', parentVersion: '2026.08.1', mappings: [bundle().mappings[0]] }))
  registry.put(bundle({ version: '2026.08.3', parentVersion: '2026.08.2', mappings: [bundle().mappings[0]] }))
  assert.throws(
    () => registry.adjustLineage({
      expectedRevision: 3,
      relationships: [
        { application: 'mobile-shell', platform: 'android', version: '2026.08.1', parentVersion: '2026.08.3' }
      ]
    }),
    (error) => error instanceof ApiError && error.code === 'lineage_cycle'
  )
  assert.equal(
    registry.snapshot().getParentVersion({ application: 'mobile-shell', platform: 'android', version: '2026.08.1' }),
    null
  )
  assert.equal(
    registry.snapshot().getParentVersion({ application: 'mobile-shell', platform: 'android', version: '2026.08.3' }),
    '2026.08.2'
  )
})

test('clears a parent when parentVersion is null', () => {
  const registry = baseRegistry()
  registry.put(bundle({ version: '2026.08.2', parentVersion: '2026.08.1', mappings: [bundle().mappings[0]] }))
  registry.adjustLineage({
    expectedRevision: 2,
    relationships: [
      { application: 'mobile-shell', platform: 'android', version: '2026.08.2', parentVersion: null }
    ]
  })
  assert.equal(
    registry.snapshot().getParentVersion({ application: 'mobile-shell', platform: 'android', version: '2026.08.2' }),
    null
  )
})

test('does not infer lineage from version strings', () => {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '2026.08.1', mappings: [bundle().mappings[0]] }))
  registry.put(bundle({ version: '2026.08.2', mappings: [bundle().mappings[1]] }))
  const result = new SymbolResolver(registry).resolve(resolveRequest({
    version: '2026.08.2',
    frames: [{ file: 'app.js', line: 10, column: 2 }]
  }))
  assert.equal(result.frames[0].status, 'unmapped')
  assert.equal(result.frames[0].resolvedFrom, null)
})
