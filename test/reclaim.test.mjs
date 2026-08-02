import assert from 'node:assert/strict'
import test from 'node:test'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { ApiError } from '../src/errors.mjs'
import { SymbolResolver } from '../src/resolver.mjs'
import { bundle, lineageRequest, reclaimRequest, resolveRequest, rollbackRequest } from '../test-support/fixtures.mjs'

const tick = () => new Promise((resolve) => setImmediate(resolve))

function uniqueBundle (version, file) {
  return bundle({
    version,
    mappings: [{
      generated: { file, line: 1, column: 0 },
      source: { file: `src/${file}.ts`, line: 5, column: 2 }
    }]
  })
}

test('preview reports reclaimable content without changing state', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(uniqueBundle('2026.08.2', 'hotfix.js'))
  const preview = registry.previewReclaim(reclaimRequest({ versions: ['2026.08.2'] }))
  assert.equal(preview.basedOnRevision, 2)
  assert.deepEqual(preview.reclaimable, [{ application: 'mobile-shell', platform: 'android', version: '2026.08.2' }])
  assert.deepEqual(preview.blocked, [])
  assert.equal(preview.freedArtifacts, 1)
  // Nothing was actually removed.
  assert.equal(registry.stats().releaseCount, 2)
  assert.equal(registry.stats().artifactCount, 2)
})

test('reclaim deletes the release and frees its unshared artifact at a new revision', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(uniqueBundle('2026.08.2', 'hotfix.js'))
  const preview = registry.previewReclaim(reclaimRequest({ versions: ['2026.08.2'] }))
  const result = registry.reclaimBundles(reclaimRequest({ versions: ['2026.08.2'], expectedRevision: preview.basedOnRevision }))
  assert.equal(result.operation, 'reclaim')
  assert.equal(result.revision, 3)
  assert.equal(result.reclaimedReleases, 1)
  assert.equal(result.freedArtifacts, 1)
  assert.equal(registry.stats().releaseCount, 1)
  assert.equal(registry.stats().artifactCount, 1)
})

test('reclaim keeps shared content while another release still references it', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(bundle({ version: '2026.08.2' })) // identical content, shared digest
  const preview = registry.previewReclaim(reclaimRequest({ versions: ['2026.08.2'] }))
  assert.equal(preview.freedArtifacts, 0)
  registry.reclaimBundles(reclaimRequest({ versions: ['2026.08.2'], expectedRevision: 2 }))
  // The release is gone, but the shared artifact survives for 2026.08.1.
  assert.equal(registry.stats().releaseCount, 1)
  assert.equal(registry.stats().artifactCount, 1)
})

test('blocks reclamation of content referenced by the current lineage', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(uniqueBundle('2026.08.2', 'hotfix.js'))
  registry.applyLineage(lineageRequest({ expectedRevision: 2 }))
  const preview = registry.previewReclaim(reclaimRequest({ versions: ['2026.08.1', '2026.08.2'] }))
  assert.deepEqual(preview.reclaimable, [])
  assert.equal(preview.blocked.length, 2)
  assert.ok(preview.blocked.every((entry) => entry.reasons.includes('referenced_by_lineage')))
})

test('blocks reclamation of content still inside the rollback history window', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(uniqueBundle('2026.08.2', 'hotfix.js'))
  registry.applyLineage(lineageRequest({ expectedRevision: 2 }))
  registry.rollbackLineage(rollbackRequest({ expectedRevision: 3, toRevision: 2 }))
  // Lineage is now empty, but history still names both releases in its window.
  assert.equal(registry.stats().lineageCount, 0)
  const preview = registry.previewReclaim(reclaimRequest({ versions: ['2026.08.2'] }))
  assert.deepEqual(preview.reclaimable, [])
  assert.equal(preview.blocked[0].reasons.includes('referenced_by_history'), true)
})

test('blocks reclamation of content held by an active batch read lease', async () => {
  const registry = new BundleRegistry()
  registry.put(uniqueBundle('2026.08.2', 'hotfix.js'))
  registry.put(bundle()) // unrelated release so the registry is non-empty
  const resolver = new SymbolResolver(registry)

  let releaseGate
  const gate = new Promise((resolve) => { releaseGate = resolve })
  const inflight = resolver.resolveBatch({
    items: [resolveRequest({ version: '2026.08.2', frames: [{ file: 'hotfix.js', line: 1, column: 0 }] })]
  }, {
    maxConcurrency: 1,
    beforeResolve: async () => { await gate }
  })
  await tick()
  assert.equal(registry.stats().activeLeases, 1)

  const preview = registry.previewReclaim(reclaimRequest({ versions: ['2026.08.2'] }))
  assert.deepEqual(preview.reclaimable, [])
  assert.equal(preview.blocked[0].reasons.includes('referenced_by_active_batch'), true)

  releaseGate()
  await inflight
  // Once the batch finishes, the lease is released and reclamation is allowed.
  assert.equal(registry.stats().activeLeases, 0)
  const after = registry.previewReclaim(reclaimRequest({ versions: ['2026.08.2'] }))
  assert.deepEqual(after.reclaimable.map((e) => e.version), ['2026.08.2'])
})

test('refuses formal reclaim when the revision moved since preview', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(uniqueBundle('2026.08.2', 'hotfix.js'))
  const preview = registry.previewReclaim(reclaimRequest({ versions: ['2026.08.2'] }))
  // Something else advances the registry after the preview.
  registry.put(uniqueBundle('2026.08.3', 'other.js'))
  assert.throws(
    () => registry.reclaimBundles(reclaimRequest({ versions: ['2026.08.2'], expectedRevision: preview.basedOnRevision })),
    (error) => error instanceof ApiError && error.code === 'revision_conflict'
  )
  assert.equal(registry.stats().releaseCount, 3)
})

test('refuses formal reclaim when any requested version is blocked', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(uniqueBundle('2026.08.2', 'hotfix.js'))
  registry.applyLineage(lineageRequest({ expectedRevision: 2 }))
  assert.throws(
    () => registry.reclaimBundles(reclaimRequest({ versions: ['2026.08.2'], expectedRevision: 3 })),
    (error) => error instanceof ApiError && error.code === 'reclaim_blocked'
  )
  assert.equal(registry.stats().releaseCount, 2)
})

test('re-uploading after reclaim is a fresh release, not a resurrection shortcut', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(uniqueBundle('2026.08.2', 'hotfix.js'))
  registry.reclaimBundles(reclaimRequest({ versions: ['2026.08.2'], expectedRevision: 2 }))
  assert.equal(registry.stats().releaseCount, 1)
  // Re-upload is allowed but is a normal new registration at a new revision;
  // reclamation is not something you undo by re-uploading over a live reference.
  const reput = registry.put(uniqueBundle('2026.08.2', 'hotfix.js'))
  assert.equal(reput.revision, 4)
  assert.equal(registry.stats().releaseCount, 2)
})

test('reports an unknown requested version as blocked, not reclaimable', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  const preview = registry.previewReclaim(reclaimRequest({ versions: ['2026.09.9'] }))
  assert.deepEqual(preview.reclaimable, [])
  assert.equal(preview.blocked[0].reason, 'unknown_version')
})

test('only reclaims within the requested application/platform scope', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(bundle({ application: 'other-app', version: '2026.08.1' }))
  // Requesting mobile-shell must not touch other-app even at the same version.
  registry.reclaimBundles(reclaimRequest({ versions: ['2026.08.1'], expectedRevision: 2 }))
  assert.equal(registry.stats().releaseCount, 1)
  assert.equal(
    registry.requireBundle({ application: 'other-app', platform: 'android', version: '2026.08.1' }).identity.application,
    'other-app'
  )
})
