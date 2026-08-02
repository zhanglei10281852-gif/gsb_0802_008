import assert from 'node:assert/strict'
import test from 'node:test'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { ApiError } from '../src/errors.mjs'
import { SymbolResolver } from '../src/resolver.mjs'
import { bundle, resolveRequest } from '../test-support/fixtures.mjs'

function twoReleases () {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '2026.08.1' }))
  registry.put(bundle({
    version: '2026.08.2',
    mappings: [
      { generated: { file: 'new.js', line: 1, column: 0 }, source: { file: 'src/new.ts', line: 1, column: 0 } }
    ]
  }))
  return registry
}

test('preview reports edge changes and frame-level impact without applying', () => {
  const registry = twoReleases()
  const before = registry.stats().revision

  const preview = registry.previewLineage({
    expectedRevision: before,
    relationships: [
      { application: 'mobile-shell', platform: 'android', version: '2026.08.2', parentVersion: '2026.08.1' }
    ]
  })

  assert.equal(preview.ok, true)
  assert.equal(preview.baseRevision, before)
  assert.equal(preview.nextRevision, before + 1)
  assert.equal(preview.revisionMismatch, false)
  assert.deepEqual(preview.changes, [
    { application: 'mobile-shell', platform: 'android', version: '2026.08.2', fromVersion: null, toVersion: '2026.08.1' }
  ])

  const affected = preview.affectedReleases.find((r) => r.version === '2026.08.2')
  assert.ok(affected, '2026.08.2 should be listed as affected')
  const changedFrame = affected.frameChanges.find((f) => f.generated.file === 'app.js')
  assert.deepEqual(changedFrame.from, { status: 'unmapped', resolvedFrom: null })
  assert.deepEqual(changedFrame.to, { status: 'ancestor', resolvedFrom: '2026.08.1' })

  assert.equal(registry.stats().revision, before, 'preview must not advance revision')
  const resolver = new SymbolResolver(registry)
  const unresolved = resolver.resolve(resolveRequest({
    version: '2026.08.2',
    frames: [{ file: 'app.js', line: 10, column: 2 }]
  }))
  assert.equal(unresolved.frames[0].status, 'unmapped')
})

test('preview returns rejection reasons for the same rules that apply enforces', () => {
  const registry = twoReleases()
  const rev = registry.stats().revision

  const unknown = registry.previewLineage({
    expectedRevision: rev,
    relationships: [
      { application: 'mobile-shell', platform: 'android', version: '2026.08.2', parentVersion: '9.9.9' }
    ]
  })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.rejection.code, 'unknown_version')

  registry.adjustLineage({
    expectedRevision: rev,
    relationships: [
      { application: 'mobile-shell', platform: 'android', version: '2026.08.2', parentVersion: '2026.08.1' }
    ]
  })
  registry.put(bundle({
    version: '2026.08.3',
    parentVersion: '2026.08.2',
    mappings: [bundle().mappings[0]]
  }))
  const cycle = registry.previewLineage({
    expectedRevision: rev + 2,
    relationships: [
      { application: 'mobile-shell', platform: 'android', version: '2026.08.1', parentVersion: '2026.08.3' }
    ]
  })
  assert.equal(cycle.ok, false)
  assert.equal(cycle.rejection.code, 'lineage_cycle')
  assert.equal(registry.stats().revision, rev + 2, 'rejected preview must not mutate registry')
})

test('preview flags revision mismatch but still computes against current state', () => {
  const registry = twoReleases()
  const preview = registry.previewLineage({
    expectedRevision: 999,
    relationships: [
      { application: 'mobile-shell', platform: 'android', version: '2026.08.2', parentVersion: '2026.08.1' }
    ]
  })
  assert.equal(preview.ok, true)
  assert.equal(preview.revisionMismatch, true)
  assert.equal(preview.baseRevision, registry.stats().revision)
})

test('apply records bounded lineage history including publish entries', () => {
  const registry = twoReleases()
  registry.put(bundle({
    version: '2026.08.3',
    parentVersion: '2026.08.2',
    mappings: [bundle().mappings[0]]
  }))
  const applied = registry.adjustLineage({
    expectedRevision: 3,
    relationships: [
      { application: 'mobile-shell', platform: 'android', version: '2026.08.3', parentVersion: '2026.08.1' }
    ]
  })
  assert.equal(applied.revision, 4)
  assert.equal(applied.changes[0].fromVersion, '2026.08.2')
  assert.equal(applied.changes[0].toVersion, '2026.08.1')

  const history = registry.lineageHistory()
  assert.equal(history.revision, 4)
  const kinds = history.entries.map((e) => e.kind)
  assert.ok(kinds.includes('publish'))
  assert.ok(kinds.includes('adjustment'))
  const adjustment = history.entries.find((e) => e.kind === 'adjustment')
  assert.equal(adjustment.revision, 4)
  assert.equal(adjustment.previousRevision, 3)
})

test('rollback restores prior lineage as a new validated revision', () => {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '2026.08.1' }))
  registry.put(bundle({
    version: '2026.08.2',
    parentVersion: '2026.08.1',
    mappings: [
      { generated: { file: 'new.js', line: 1, column: 0 }, source: { file: 'src/new.ts', line: 1, column: 0 } }
    ]
  }))
  registry.adjustLineage({
    expectedRevision: 2,
    relationships: [
      { application: 'mobile-shell', platform: 'android', version: '2026.08.2', parentVersion: null }
    ]
  })

  const resolver = new SymbolResolver(registry)
  const before = resolver.resolve(resolveRequest({
    version: '2026.08.2',
    frames: [{ file: 'app.js', line: 10, column: 2 }]
  }))
  assert.equal(before.frames[0].status, 'unmapped')

  const rolled = registry.rollbackLineage({ expectedRevision: 3, targetRevision: 2 })
  assert.equal(rolled.revision, 4)
  assert.equal(rolled.targetRevision, 2)
  assert.deepEqual(rolled.changes, [
    { application: 'mobile-shell', platform: 'android', version: '2026.08.2', fromVersion: null, toVersion: '2026.08.1' }
  ])

  const after = resolver.resolve(resolveRequest({
    version: '2026.08.2',
    frames: [{ file: 'app.js', line: 10, column: 2 }]
  }))
  assert.equal(after.frames[0].status, 'ancestor')
  assert.equal(after.frames[0].resolvedFrom, '2026.08.1')

  const history = registry.lineageHistory()
  const rollbackEntry = history.entries.find((e) => e.kind === 'rollback')
  assert.ok(rollbackEntry)
  assert.equal(rollbackEntry.rolledBackFrom, 2)
  assert.equal(rollbackEntry.revision, 4)
})

test('rollback requires expectedRevision match and rejects future target', () => {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '2026.08.1' }))
  registry.put(bundle({ version: '2026.08.2', parentVersion: '2026.08.1', mappings: [bundle().mappings[0]] }))

  assert.throws(
    () => registry.rollbackLineage({ expectedRevision: 99, targetRevision: 1 }),
    (error) => error instanceof ApiError && error.code === 'revision_mismatch'
  )
  assert.throws(
    () => registry.rollbackLineage({ expectedRevision: 2, targetRevision: 5 }),
    (error) => error instanceof ApiError && error.code === 'invalid_target_revision'
  )
})

test('rollback leaves releases added after the target untouched', () => {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '2026.08.1' }))
  registry.put(bundle({
    version: '2026.08.2',
    parentVersion: '2026.08.1',
    mappings: [{ generated: { file: 'a.js', line: 1, column: 0 }, source: { file: 'a.ts', line: 1, column: 0 } }]
  }))
  registry.put(bundle({
    version: '2026.08.3',
    parentVersion: '2026.08.2',
    mappings: [{ generated: { file: 'b.js', line: 1, column: 0 }, source: { file: 'b.ts', line: 1, column: 0 } }]
  }))
  registry.adjustLineage({
    expectedRevision: 3,
    relationships: [
      { application: 'mobile-shell', platform: 'android', version: '2026.08.2', parentVersion: null }
    ]
  })

  registry.rollbackLineage({ expectedRevision: 4, targetRevision: 3 })

  assert.equal(
    registry.snapshot().getParentVersion({ application: 'mobile-shell', platform: 'android', version: '2026.08.3' }),
    '2026.08.2',
    'release registered after target must keep its current parent'
  )
  assert.equal(
    registry.snapshot().getParentVersion({ application: 'mobile-shell', platform: 'android', version: '2026.08.2' }),
    '2026.08.1'
  )
})

test('a snapshot captured before a lineage switch completes in its own view', () => {
  const registry = twoReleases()
  registry.adjustLineage({
    expectedRevision: 2,
    relationships: [
      { application: 'mobile-shell', platform: 'android', version: '2026.08.2', parentVersion: '2026.08.1' }
    ]
  })
  const resolver = new SymbolResolver(registry)
  const oldSnapshot = registry.snapshot()
  assert.equal(oldSnapshot.revision, 3)

  registry.adjustLineage({
    expectedRevision: 3,
    relationships: [
      { application: 'mobile-shell', platform: 'android', version: '2026.08.2', parentVersion: null }
    ]
  })

  const fromOldView = resolver.resolveSnapshot({
    identity: { application: 'mobile-shell', platform: 'android', version: '2026.08.2' },
    frames: [{ file: 'app.js', line: 10, column: 2 }],
    snapshot: oldSnapshot
  })
  assert.equal(fromOldView.registryRevision, 3)
  assert.equal(fromOldView.frames[0].status, 'ancestor')

  const fromNewView = resolver.resolve(resolveRequest({
    version: '2026.08.2',
    frames: [{ file: 'app.js', line: 10, column: 2 }]
  }))
  assert.equal(fromNewView.registryRevision, 4)
  assert.equal(fromNewView.frames[0].status, 'unmapped')
})

test('lineage history is bounded', () => {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '2026.08.1' }))
  registry.put(bundle({ version: '2026.08.2', parentVersion: '2026.08.1', mappings: [bundle().mappings[0]] }))
  for (let i = 0; i < 105; i++) {
    const parent = i % 2 === 0 ? '2026.08.1' : null
    registry.adjustLineage({
      expectedRevision: registry.stats().revision,
      relationships: [
        { application: 'mobile-shell', platform: 'android', version: '2026.08.2', parentVersion: parent }
      ]
    })
  }
  const history = registry.lineageHistory()
  assert.ok(history.entries.length <= 100, `history must be bounded, was ${history.entries.length}`)
})

test('apply and preview share impact computation: identical change/affected output', () => {
  const registry = twoReleases()
  const rev = registry.stats().revision
  const body = {
    expectedRevision: rev,
    relationships: [
      { application: 'mobile-shell', platform: 'android', version: '2026.08.2', parentVersion: '2026.08.1' }
    ]
  }
  const preview = registry.previewLineage(body)
  const applied = registry.adjustLineage(body)
  assert.deepEqual(applied.changes, preview.changes)
  assert.deepEqual(applied.affectedReleases, preview.affectedReleases)
})
