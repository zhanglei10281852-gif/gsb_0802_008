import assert from 'node:assert/strict'
import test from 'node:test'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { ApiError } from '../src/errors.mjs'
import { bundle, lineageRequest } from '../test-support/fixtures.mjs'

function seedTwoReleases () {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(bundle({
    version: '2026.08.2',
    mappings: [{
      generated: { file: 'hotfix.js', line: 1, column: 0 },
      source: { file: 'src/hotfix.ts', line: 5, column: 2 }
    }]
  }))
  return registry
}

test('applies a lineage batch atomically at the expected revision', () => {
  const registry = seedTwoReleases()
  const result = registry.applyLineage(lineageRequest({ expectedRevision: 2 }))
  assert.equal(result.revision, 3)
  assert.equal(result.appliedRelations, 1)
  assert.equal(result.lineageSize, 1)
  assert.equal(registry.stats().lineageCount, 1)
})

test('rejects the whole batch on a stale expected revision', () => {
  const registry = seedTwoReleases()
  assert.throws(
    () => registry.applyLineage(lineageRequest({ expectedRevision: 1 })),
    (error) => error instanceof ApiError && error.statusCode === 409 && error.code === 'revision_conflict'
  )
  assert.equal(registry.stats().revision, 2)
  assert.equal(registry.stats().lineageCount, 0)
})

test('rejects relations that reference an unknown version', () => {
  const registry = seedTwoReleases()
  assert.throws(
    () => registry.applyLineage(lineageRequest({
      expectedRevision: 2,
      relations: [{ version: '2026.08.2', parent: '2026.08.9' }]
    })),
    (error) => error instanceof ApiError && error.code === 'unknown_version'
  )
  assert.equal(registry.stats().lineageCount, 0)
})

test('rejects relations that cross the application or platform boundary', () => {
  const registry = seedTwoReleases()
  assert.throws(
    () => registry.applyLineage(lineageRequest({
      expectedRevision: 2,
      relations: [{ version: '2026.08.2', parent: '2026.08.1', platform: 'ios' }]
    })),
    (error) => error instanceof ApiError && error.code === 'cross_boundary_relation'
  )
})

test('rejects duplicate relations inside one batch', () => {
  const registry = seedTwoReleases()
  assert.throws(
    () => registry.applyLineage(lineageRequest({
      expectedRevision: 2,
      relations: [
        { version: '2026.08.2', parent: '2026.08.1' },
        { version: '2026.08.2', parent: '2026.08.1' }
      ]
    })),
    (error) => error instanceof ApiError && error.code === 'duplicate_relation'
  )
})

test('rejects a relation that already exists', () => {
  const registry = seedTwoReleases()
  registry.applyLineage(lineageRequest({ expectedRevision: 2 }))
  assert.throws(
    () => registry.applyLineage(lineageRequest({ expectedRevision: 3 })),
    (error) => error instanceof ApiError && error.code === 'duplicate_relation'
  )
})

test('rejects a batch that would introduce a cycle', () => {
  const registry = seedTwoReleases()
  registry.put(bundle({ version: '2026.08.3' }))
  assert.throws(
    () => registry.applyLineage(lineageRequest({
      expectedRevision: 3,
      relations: [
        { version: '2026.08.2', parent: '2026.08.3' },
        { version: '2026.08.3', parent: '2026.08.2' }
      ]
    })),
    (error) => error instanceof ApiError && error.code === 'lineage_cycle'
  )
  assert.equal(registry.stats().lineageCount, 0)
})

test('does not create the bundle content by declaring lineage', () => {
  const registry = seedTwoReleases()
  registry.applyLineage(lineageRequest({ expectedRevision: 2 }))
  // Declaring lineage keeps the artifact and release counts unchanged.
  assert.deepEqual(registry.stats(), {
    revision: 3,
    releaseCount: 2,
    artifactCount: 2,
    lineageCount: 1,
    historyDepth: 2
  })
})
