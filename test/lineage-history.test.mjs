import assert from 'node:assert/strict'
import test from 'node:test'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { ApiError } from '../src/errors.mjs'
import { bundle } from '../test-support/fixtures.mjs'

const base = { application: 'mobile-shell', platform: 'android' }
const release = (version, parentVersion = null) => ({ ...base, version, parentVersion })
const change = (version, parentVersion) => ({ ...base, version, parentVersion })

function buildChain () {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '1.0.0' }))
  registry.put(bundle({ version: '1.1.0', parentVersion: '1.0.0' }))
  registry.put(bundle({ version: '1.2.0', parentVersion: '1.1.0' }))
  registry.put(bundle({ version: '1.2.1', parentVersion: '1.2.0' }))
  return registry
}

test('previewLineage is read-only and reports the affected release scope', () => {
  const registry = buildChain()
  const before = registry.stats().revision
  const preview = registry.previewLineage({
    expectedRevision: 4,
    changes: [change('1.2.0', '1.0.0')]
  })
  assert.equal(preview.valid, true)
  assert.equal(preview.currentRevision, 4)
  assert.deepEqual(preview.errors, [])
  const affected = preview.affectedReleases.map((r) => r.version).sort()
  assert.deepEqual(affected, ['1.2.0', '1.2.1'])
  assert.equal(registry.stats().revision, before)
  const snapshot = registry.snapshot()
  assert.deepEqual(
    snapshot.ancestorsOf({ ...base, version: '1.2.0' }).map((b) => b.identity.version),
    ['1.1.0', '1.0.0']
  )
})

test('previewLineage surfaces rejection reasons without mutating state', () => {
  const registry = buildChain()
  const preview = registry.previewLineage({
    changes: [
      change('1.2.0', '1.0.0'),
      change('ghost', '1.0.0'),
      change('1.0.0', '1.2.1')
    ]
  })
  assert.equal(preview.valid, false)
  assert.equal(preview.affectedReleases.length, 0)
  const codes = preview.errors.map((e) => e.code)
  assert.ok(codes.includes('unknown_release'))
  assert.equal(registry.stats().revision, 4)
})

test('adjustLineage returns impact and records bounded history', () => {
  const registry = buildChain()
  const result = registry.adjustLineage({
    expectedRevision: 4,
    changes: [change('1.2.0', '1.0.0')]
  })
  assert.equal(result.revision, 5)
  assert.equal(result.applied, 1)
  const affected = result.affectedReleases.map((r) => r.version).sort()
  assert.deepEqual(affected, ['1.2.0', '1.2.1'])
  assert.deepEqual(registry.lineageHistory(), [0, 2, 3, 4, 5])
  const snapshot = registry.snapshot()
  assert.deepEqual(
    snapshot.ancestorsOf({ ...base, version: '1.2.0' }).map((b) => b.identity.version),
    ['1.0.0']
  )
})

test('rollbackLineage applies a new validated change rather than overwriting revision', () => {
  const registry = buildChain()
  registry.adjustLineage({ expectedRevision: 4, changes: [change('1.2.0', '1.0.0')] })
  assert.equal(registry.stats().revision, 5)

  const restored = registry.rollbackLineage({ expectedRevision: 5, toRevision: 4 })
  assert.equal(restored.revision, 6)
  assert.equal(restored.previousRevision, 5)
  assert.equal(restored.targetRevision, 4)
  assert.ok(restored.applied > 0)
  const affected = restored.affectedReleases.map((r) => r.version).sort()
  assert.deepEqual(affected, ['1.2.0', '1.2.1'])

  const snapshot = registry.snapshot()
  assert.deepEqual(
    snapshot.ancestorsOf({ ...base, version: '1.2.0' }).map((b) => b.identity.version),
    ['1.1.0', '1.0.0']
  )
})

test('previewRollback reports the derived changes and refuses revisions outside history', () => {
  const registry = buildChain()
  registry.adjustLineage({ expectedRevision: 4, changes: [change('1.2.0', '1.0.0')] })

  const preview = registry.previewRollback({ expectedRevision: 5, toRevision: 4 })
  assert.equal(preview.valid, true)
  assert.equal(preview.currentRevision, 5)
  assert.equal(preview.targetRevision, 4)
  assert.equal(preview.changes.length, 1)
  assert.equal(preview.changes[0].version, '1.2.0')
  assert.equal(preview.changes[0].parentVersion, '1.1.0')

  const tooOld = registry.previewRollback({ toRevision: 0 })
  assert.equal(tooOld.valid, true)
  assert.equal(tooOld.changes.length, 3)

  const missing = registry.previewRollback({ toRevision: 999 })
  assert.equal(missing.valid, false)
  assert.equal(missing.errors[0].code, 'revision_not_in_history')
})

test('rollback still enforces revision expectations', () => {
  const registry = buildChain()
  registry.adjustLineage({ expectedRevision: 4, changes: [change('1.2.0', '1.0.0')] })
  assert.throws(
    () => registry.rollbackLineage({ expectedRevision: 4, toRevision: 4 }),
    (error) => error instanceof ApiError && error.code === 'revision_conflict'
  )
})

test('history is bounded and old revisions become un-rollback-able', () => {
  const registry = new BundleRegistry({ historyLimit: 3 })
  registry.put(bundle({ version: '1.0.0' }))
  registry.put(bundle({ version: '1.1.0', parentVersion: '1.0.0' }))
  registry.put(bundle({ version: '1.2.0', parentVersion: '1.1.0' }))
  registry.put(bundle({ version: '1.3.0', parentVersion: '1.2.0' }))
  assert.deepEqual(registry.lineageHistory(), [2, 3, 4])
  const preview = registry.previewRollback({ toRevision: 1 })
  assert.equal(preview.valid, false)
  assert.equal(preview.errors[0].code, 'revision_not_in_history')
  assert.throws(
    () => registry.rollbackLineage({ toRevision: 1 }),
    (error) => error instanceof ApiError && error.code === 'revision_not_in_history'
  )
})

test('adjust and rollback share the same cycle and boundary validation', () => {
  const registry = buildChain()
  assert.throws(
    () => registry.adjustLineage({ changes: [change('1.0.0', '1.2.1')] }),
    (error) => error instanceof ApiError && error.code === 'lineage_cycle'
  )
  assert.throws(
    () => registry.adjustLineage({ changes: [change('1.2.0', '9.9.9')] }),
    (error) => error instanceof ApiError && error.code === 'unknown_parent_release'
  )
})
