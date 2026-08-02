import assert from 'node:assert/strict'
import test from 'node:test'
import { BatchLeaseManager } from '../src/batch-lease-manager.mjs'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { ApiError } from '../src/errors.mjs'
import { SymbolResolver } from '../src/resolver.mjs'
import { bundle, resolveRequest } from '../test-support/fixtures.mjs'

test('shared source map content is counted once and pinned by current releases', () => {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '1.0.0' }))
  registry.put(bundle({ version: '1.1.0' }))
  const preview = registry.previewGc()
  assert.equal(preview.currentRevision, 2)
  assert.equal(preview.reclaimable.length, 0)
  assert.equal(preview.retained.currentReleaseDigestCount, 1)
  assert.equal(preview.retained.historyWindowDigestCount, 0)
})

test('lineage history pins the digests that existed when the edge was recorded', () => {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '1.0.0' }))
  registry.put(bundle({
    version: '1.1.0',
    parentVersion: '1.0.0',
    mappings: [{
      generated: { file: 'patch.js', line: 1, column: 0 },
      source: { file: 'src/patch.ts', line: 1, column: 0 }
    }]
  }))
  const preview = registry.previewGc()
  assert.equal(preview.reclaimable.length, 0)
  assert.equal(preview.retained.currentReleaseDigestCount, 2)
  assert.equal(preview.retained.historyWindowDigestCount, 2)
})

test('reclaimArtifacts refuses stale callers based on the preview revision', () => {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '1.0.0' }))
  assert.throws(
    () => registry.reclaimArtifacts({ expectedRevision: 99 }),
    (error) => error instanceof ApiError && error.code === 'gc_revision_conflict'
  )
})

test('active batch leases pin artifacts and are released when the batch finishes', async () => {
  const leaseManager = new BatchLeaseManager()
  const registry = new BundleRegistry({ leaseManager })
  registry.put(bundle({ version: '1.0.0' }))
  const orphanDigest = registry.snapshot().artifacts.keys().next().value
  const resolver = new SymbolResolver(registry, { leaseManager })

  let releaseWork
  const slowResolver = new SymbolResolver(registry, {
    leaseManager,
    executeWork: ({ resolve }) => new Promise((workResolve) => {
      releaseWork = () => workResolve(resolve())
    })
  })

  const batchPromise = slowResolver.resolveBatch({
    items: [resolveRequest({ version: '1.0.0' })],
    concurrency: 1
  })
  await new Promise((resolve) => setImmediate(resolve))

  const leasedPreview = registry.previewGc()
  assert.equal(leasedPreview.retained.activeBatchCount, 1)
  assert.equal(leasedPreview.retained.activeLeaseDigestCount, 1)
  assert.equal(leasedPreview.reclaimable.length, 0)

  releaseWork()
  await batchPromise

  const afterRelease = registry.previewGc()
  assert.equal(afterRelease.retained.activeBatchCount, 0)
  assert.equal(afterRelease.retained.activeLeaseDigestCount, 0)
  assert.equal(afterRelease.reclaimable.length, 0)
  assert.ok(orphanDigest)
})

test('GC never reclaims artifacts needed by exact or ancestor resolution', async () => {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '1.0.0' }))
  registry.put(bundle({
    version: '1.1.0',
    parentVersion: '1.0.0',
    mappings: [{
      generated: { file: 'patch.js', line: 1, column: 0 },
      source: { file: 'src/patch.ts', line: 1, column: 0 }
    }]
  }))
  const preview = registry.previewGc()
  assert.equal(preview.reclaimable.length, 0)
  assert.equal(preview.retained.currentReleaseDigestCount, 2)

  const resolver = new SymbolResolver(registry)
  const result = resolver.resolve(resolveRequest({
    version: '1.1.0',
    frames: [{ file: 'app.js', line: 10, column: 2 }]
  }))
  assert.equal(result.frames[0].status, 'ancestor')
})

test('GC is a no-op when no artifacts are unreferenced', () => {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '1.0.0' }))
  const result = registry.reclaimArtifacts({ expectedRevision: 1 })
  assert.equal(result.reclaimed, 0)
  assert.equal(result.revision, 1)
  assert.equal(registry.stats().artifactCount, 1)
})
