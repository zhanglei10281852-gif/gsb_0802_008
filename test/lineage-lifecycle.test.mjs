import assert from 'node:assert/strict'
import test from 'node:test'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { ApiError } from '../src/errors.mjs'
import { planRollback } from '../src/lineage-engine.mjs'
import { SymbolResolver } from '../src/resolver.mjs'
import { bundle, lineageRequest, resolveRequest, rollbackRequest } from '../test-support/fixtures.mjs'

function seedThreeReleases () {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(bundle({
    version: '2026.08.2',
    mappings: [{
      generated: { file: 'hotfix.js', line: 1, column: 0 },
      source: { file: 'src/hotfix.ts', line: 5, column: 2 }
    }]
  }))
  registry.put(bundle({ version: '2026.08.3' }))
  return registry
}

test('preview reports affected releases without changing state', () => {
  const registry = seedThreeReleases()
  const preview = registry.previewLineage(lineageRequest({ expectedRevision: 3 }))
  assert.equal(preview.ok, true)
  assert.equal(preview.rejection, null)
  assert.equal(preview.basedOnRevision, 3)
  assert.equal(preview.changeCount, 1)
  assert.deepEqual(preview.impact, [{
    application: 'mobile-shell',
    platform: 'android',
    version: '2026.08.2',
    previousAncestry: [],
    nextAncestry: ['2026.08.1']
  }])
  // Preview is read-only: revision and lineage are untouched.
  assert.equal(registry.stats().revision, 3)
  assert.equal(registry.stats().lineageCount, 0)
})

test('preview surfaces the rejection reason instead of throwing', () => {
  const registry = seedThreeReleases()
  const preview = registry.previewLineage(lineageRequest({
    expectedRevision: 3,
    relations: [{ version: '2026.08.2', parent: '2026.08.9' }]
  }))
  assert.equal(preview.ok, false)
  assert.equal(preview.rejection.code, 'unknown_version')
  assert.deepEqual(preview.impact, [])
  assert.equal(registry.stats().revision, 3)
})

test('preview reports a revision conflict as a rejection', () => {
  const registry = seedThreeReleases()
  const preview = registry.previewLineage(lineageRequest({ expectedRevision: 1 }))
  assert.equal(preview.ok, false)
  assert.equal(preview.rejection.code, 'revision_conflict')
})

test('rollback restores an earlier lineage as a new validated revision', () => {
  const registry = seedThreeReleases()
  const applied = registry.applyLineage(lineageRequest({ expectedRevision: 3 }))
  assert.equal(applied.revision, 4)
  assert.equal(registry.stats().lineageCount, 1)

  const rolledBack = registry.rollbackLineage(rollbackRequest({ expectedRevision: 4, toRevision: 3 }))
  assert.equal(rolledBack.operation, 'rollback')
  assert.equal(rolledBack.revision, 5)
  assert.equal(rolledBack.restoredFromRevision, 3)
  // Rollback is a forward revision, not a resurrection of the old one.
  assert.equal(registry.stats().revision, 5)
  assert.equal(registry.stats().lineageCount, 0)
})

test('rollback still validates the caller revision', () => {
  const registry = seedThreeReleases()
  registry.applyLineage(lineageRequest({ expectedRevision: 3 }))
  assert.throws(
    () => registry.rollbackLineage(rollbackRequest({ expectedRevision: 3, toRevision: 3 })),
    (error) => error instanceof ApiError && error.code === 'revision_conflict'
  )
})

test('rollback refuses to revive a release that no longer exists', () => {
  // The engine owns this rule; drive it directly with a checkpoint that names a
  // release the current registry no longer knows about.
  const scope = { application: 'mobile-shell', platform: 'android' }
  const bundles = new Map([
    ['mobile-shell\u0000android\u00002026.08.1', {}]
  ])
  const targetLineage = new Map([
    ['mobile-shell\u0000android\u00002026.08.2', 'mobile-shell\u0000android\u00002026.08.1']
  ])
  assert.throws(
    () => planRollback({ bundles, lineage: new Map(), scope, targetLineage }),
    (error) => error instanceof ApiError && error.code === 'unknown_version'
  )
})

test('rollback only touches its own application/platform scope', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(bundle({ version: '2026.08.2' }))
  registry.put(bundle({ application: 'other-app', version: '1.0.0' }))
  registry.put(bundle({ application: 'other-app', version: '1.0.1' }))
  const afterFirst = registry.applyLineage(lineageRequest({ expectedRevision: 4 }))
  registry.applyLineage(lineageRequest({
    application: 'other-app',
    platform: 'android',
    expectedRevision: afterFirst.revision,
    relations: [{ version: '1.0.1', parent: '1.0.0' }]
  }))
  const beforeRollback = registry.stats().lineageCount
  assert.equal(beforeRollback, 2)

  // Rolling mobile-shell back to before its edge keeps the other-app edge intact.
  registry.rollbackLineage(rollbackRequest({ expectedRevision: 6, toRevision: 4 }))
  assert.equal(registry.stats().lineageCount, 1)
})

test('keeps lineage history bounded', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(bundle({ version: '2026.08.2' }))
  registry.put(bundle({ version: '2026.08.3' }))
  let expected = 3
  // Alternately add and roll back to churn history well past the bound. Rolling
  // back to the immediately prior revision always stays inside the retained
  // window, so the only thing under test is that depth stops growing.
  for (let i = 0; i < 200; i += 1) {
    if (registry.stats().lineageCount === 0) {
      registry.applyLineage(lineageRequest({ expectedRevision: expected }))
    } else {
      registry.rollbackLineage(rollbackRequest({ expectedRevision: expected, toRevision: expected - 1 }))
    }
    expected += 1
    assert.ok(registry.stats().historyDepth <= 64, `history depth ${registry.stats().historyDepth} should stay bounded`)
  }
})

test('a request keeps resolving against the snapshot it already captured', () => {
  const registry = seedThreeReleases()
  registry.applyLineage(lineageRequest({ expectedRevision: 3 }))
  const snapshot = registry.snapshot()
  assert.equal(snapshot.revision, 4)

  // Lineage changes after capture; the held snapshot must still see revision 4.
  registry.rollbackLineage(rollbackRequest({ expectedRevision: 4, toRevision: 3 }))
  const resolver = new SymbolResolver(registry)
  const withinSnapshot = resolver.resolveSnapshot({
    identity: { application: 'mobile-shell', platform: 'android', version: '2026.08.2' },
    frames: [{ file: 'app.js', line: 10, column: 2 }],
    snapshot
  })
  assert.equal(withinSnapshot.registryRevision, 4)
  assert.equal(withinSnapshot.frames[0].status, 'ancestor')
  assert.equal(withinSnapshot.frames[0].resolvedFrom, '2026.08.1')

  // A fresh request only sees the newest revision, where the edge is gone.
  const afterRollback = resolver.resolve(resolveRequest({
    version: '2026.08.2',
    frames: [{ file: 'app.js', line: 10, column: 2 }]
  }))
  assert.equal(afterRollback.registryRevision, 5)
  assert.equal(afterRollback.frames[0].status, 'unmapped')
})
