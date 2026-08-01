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
  const snapshot = registry.snapshot()
  snapshot.bundles.values().next().value.identity.application = 'mutated'
  assert.equal(registry.requireBundle({ application: 'mobile-shell', platform: 'android', version: '2026.08.1' }).identity.application, 'mobile-shell')
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
