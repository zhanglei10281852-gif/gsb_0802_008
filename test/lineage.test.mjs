import assert from 'node:assert/strict'
import test from 'node:test'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { ApiError } from '../src/errors.mjs'
import { bundle } from '../test-support/fixtures.mjs'

function putChain (registry) {
  registry.put(bundle({ version: '1.0.0' }))
  registry.put(bundle({ version: '1.1.0', parentVersion: '1.0.0' }))
  registry.put(bundle({ version: '1.2.0', parentVersion: '1.1.0' }))
}

test('declares parent at publish time and walks the chain through snapshots', () => {
  const registry = new BundleRegistry()
  putChain(registry)
  const snapshot = registry.snapshot()
  const chain = snapshot.ancestorsOf({ application: 'mobile-shell', platform: 'android', version: '1.2.0' })
  assert.deepEqual(chain.map((b) => b.identity.version), ['1.1.0', '1.0.0'])
  assert.equal(registry.stats().lineageEdgeCount, 2)
})

test('rejects re-uploading an existing release even with identical mappings', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  assert.throws(
    () => registry.put(bundle()),
    (error) => error instanceof ApiError && error.code === 'release_already_exists'
  )
})

test('rejects a self referential parent', () => {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '1.0.0' }))
  assert.throws(
    () => registry.put(bundle({ version: '1.0.1', parentVersion: '1.0.1' })),
    (error) => error instanceof ApiError && error.code === 'invalid_parent_version'
  )
})

test('adjustLineage applies a group atomically and bumps revision once', () => {
  const registry = new BundleRegistry()
  putChain(registry)
  const result = registry.adjustLineage({
    expectedRevision: 3,
    changes: [
      { application: 'mobile-shell', platform: 'android', version: '1.2.0', parentVersion: '1.0.0' },
      { application: 'mobile-shell', platform: 'android', version: '1.1.0', parentVersion: null }
    ]
  })
  assert.equal(result.applied, 2)
  assert.equal(result.revision, 4)
  assert.equal(result.previousRevision, 3)
  const snapshot = registry.snapshot()
  assert.deepEqual(
    snapshot.ancestorsOf({ application: 'mobile-shell', platform: 'android', version: '1.2.0' })
      .map((b) => b.identity.version),
    ['1.0.0']
  )
  assert.deepEqual(
    snapshot.ancestorsOf({ application: 'mobile-shell', platform: 'android', version: '1.1.0' }),
    []
  )
})

test('adjustLineage rejects revision conflicts without mutating state', () => {
  const registry = new BundleRegistry()
  putChain(registry)
  assert.throws(
    () => registry.adjustLineage({
      expectedRevision: 99,
      changes: [{ application: 'mobile-shell', platform: 'android', version: '1.1.0', parentVersion: null }]
    }),
    (error) => error instanceof ApiError && error.code === 'revision_conflict'
  )
  assert.equal(registry.stats().revision, 3)
})

test('adjustLineage rejects unknown releases and leaves state unchanged', () => {
  const registry = new BundleRegistry()
  putChain(registry)
  assert.throws(
    () => registry.adjustLineage({
      changes: [
        { application: 'mobile-shell', platform: 'android', version: '1.1.0', parentVersion: null },
        { application: 'mobile-shell', platform: 'android', version: '9.9.9', parentVersion: '1.0.0' }
      ]
    }),
    (error) => error instanceof ApiError && error.code === 'unknown_release'
  )
  assert.equal(registry.stats().lineageEdgeCount, 2)
  assert.equal(registry.stats().revision, 3)
})

test('adjustLineage rejects unknown parent releases across the boundary', () => {
  const registry = new BundleRegistry()
  putChain(registry)
  assert.throws(
    () => registry.adjustLineage({
      changes: [
        { application: 'mobile-shell', platform: 'android', version: '1.2.0', parentVersion: '9.9.9' }
      ]
    }),
    (error) => error instanceof ApiError && error.code === 'unknown_parent_release'
  )
})

test('adjustLineage rejects duplicate relationships in the same batch', () => {
  const registry = new BundleRegistry()
  putChain(registry)
  assert.throws(
    () => registry.adjustLineage({
      changes: [
        { application: 'mobile-shell', platform: 'android', version: '1.2.0', parentVersion: '1.0.0' },
        { application: 'mobile-shell', platform: 'android', version: '1.2.0', parentVersion: null }
      ]
    }),
    (error) => error instanceof ApiError && error.code === 'duplicate_lineage_change'
  )
  assert.equal(registry.stats().revision, 3)
})

test('adjustLineage rejects cycles and leaves the graph untouched', () => {
  const registry = new BundleRegistry()
  putChain(registry)
  assert.throws(
    () => registry.adjustLineage({
      changes: [
        { application: 'mobile-shell', platform: 'android', version: '1.0.0', parentVersion: '1.2.0' }
      ]
    }),
    (error) => error instanceof ApiError && error.code === 'lineage_cycle'
  )
  const snapshot = registry.snapshot()
  assert.equal(snapshot.getParentKey(bundleKey({ application: 'mobile-shell', platform: 'android', version: '1.0.0' })), null)
  assert.equal(registry.stats().revision, 3)
})

function bundleKey (identity) {
  return `${identity.application}\u0000${identity.platform}\u0000${identity.version}`
}
