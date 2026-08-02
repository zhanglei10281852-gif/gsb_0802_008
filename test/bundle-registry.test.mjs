import assert from 'node:assert/strict'
import test from 'node:test'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { ApiError } from '../src/errors.mjs'
import { bundle } from '../test-support/fixtures.mjs'

test('stores a release bundle and exposes a detached snapshot', () => {
  const registry = new BundleRegistry()
  const created = registry.put(bundle())
  assert.equal(created.revision, 1)
  assert.equal(created.mappingCount, 2)
  assert.match(created.bundleDigest, /^[a-f0-9]{64}$/)
  const snapshot = registry.snapshot()
  snapshot.bundles.values().next().value.identity.application = 'mutated'
  assert.equal(registry.requireBundle({ application: 'mobile-shell', platform: 'android', version: '2026.08.1' }).identity.application, 'mobile-shell')
})

test('shares immutable bundle content without sharing release descriptors', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  const second = registry.put(bundle({ version: '2026.08.2' }))
  assert.equal(second.reusedContent, true)
  assert.deepEqual(registry.stats(), { revision: 2, releaseCount: 2, artifactCount: 1, lineageCount: 0, historyDepth: 1, activeLeases: 0 })
  assert.notEqual(
    registry.requireBundle({ application: 'mobile-shell', platform: 'android', version: '2026.08.1' }).identity.version,
    registry.requireBundle({ application: 'mobile-shell', platform: 'android', version: '2026.08.2' }).identity.version
  )
})

test('rejects duplicate generated positions', () => {
  const registry = new BundleRegistry()
  assert.throws(
    () => registry.put(bundle({ mappings: [
      bundle().mappings[0],
      bundle().mappings[0]
    ] })),
    (error) => error instanceof ApiError && error.code === 'duplicate_mapping'
  )
})
