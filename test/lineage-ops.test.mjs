import assert from 'node:assert/strict'
import test from 'node:test'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { ResolutionCache } from '../src/resolution-cache.mjs'
import { SymbolResolver } from '../src/resolver.mjs'
import { ApiError } from '../src/errors.mjs'
import { bundle, childBundle, lineageChange, resolveRequest } from '../test-support/fixtures.mjs'

const parentOf = (registry, version) =>
  registry.snapshot().getParent({ application: 'mobile-shell', platform: 'android', version })

const appJsFrame = { file: 'app.js', line: 10, column: 2 }

function setupChain () {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(childBundle())
  registry.put(bundle({ version: '2026.08.3' }))
  registry.applyLineage({ revision: 3, changes: [lineageChange()] })
  registry.applyLineage({
    revision: 4,
    changes: [lineageChange({
      version: '2026.08.3',
      parent: { application: 'mobile-shell', platform: 'android', version: '2026.08.2' }
    })]
  })
  return registry
}

test('previews a valid batch with resolution impact and touches no state', () => {
  const registry = setupChain()
  const preview = registry.previewLineage({
    revision: 5,
    changes: [lineageChange({ parent: null })]
  })
  assert.equal(preview.revision, 5)
  assert.equal(preview.baseRevision, 5)
  assert.equal(preview.stale, false)
  assert.equal(preview.valid, true)
  assert.deepEqual(preview.violations, [])
  assert.deepEqual(preview.impact.changes, [{
    application: 'mobile-shell',
    platform: 'android',
    version: '2026.08.2',
    from: { application: 'mobile-shell', platform: 'android', version: '2026.08.1' },
    to: null
  }])
  assert.deepEqual(preview.impact.affectedReleases, [
    { application: 'mobile-shell', platform: 'android', version: '2026.08.2' },
    { application: 'mobile-shell', platform: 'android', version: '2026.08.3' }
  ])
  assert.equal(registry.stats().revision, 5)
  assert.deepEqual(parentOf(registry, '2026.08.2'), {
    application: 'mobile-shell',
    platform: 'android',
    version: '2026.08.1'
  })
})

test('reports every rejection reason with the offending change located', () => {
  const registry = setupChain()
  const preview = registry.previewLineage({
    revision: 5,
    changes: [
      lineageChange(),
      lineageChange({ version: '2026.09.9' }),
      lineageChange({
        version: '2026.08.3',
        parent: { application: 'web-shell', platform: 'android', version: '2026.08.1' }
      }),
      lineageChange()
    ]
  })
  assert.equal(preview.valid, false)
  assert.equal(preview.impact, null)
  assert.deepEqual(preview.violations.map((violation) => [violation.code, violation.changeIndex]), [
    ['unknown_version', 1],
    ['cross_boundary_reference', 2],
    ['duplicate_relation', 3]
  ])
  assert.equal(registry.stats().revision, 5)
})

test('flags a stale base revision in preview without rejecting the dry run', () => {
  const registry = setupChain()
  const preview = registry.previewLineage({ revision: 2, changes: [lineageChange({ parent: null })] })
  assert.equal(preview.stale, true)
  assert.equal(preview.valid, true)
  assert.equal(registry.stats().revision, 5)
})

test('previews cycles as violations and no-op changes as empty impact', () => {
  const registry = setupChain()
  const cyclic = registry.previewLineage({
    revision: 5,
    changes: [lineageChange({
      version: '2026.08.1',
      parent: { application: 'mobile-shell', platform: 'android', version: '2026.08.3' }
    })]
  })
  assert.equal(cyclic.valid, false)
  assert.deepEqual(cyclic.violations.map((violation) => violation.code), ['lineage_cycle'])

  const noop = registry.previewLineage({ revision: 5, changes: [lineageChange()] })
  assert.equal(noop.valid, true)
  assert.deepEqual(noop.impact.affectedReleases, [])
})

test('rolls back a committed batch as a new validated revision', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(childBundle())
  registry.applyLineage({ revision: 2, changes: [lineageChange()] })
  const rolledBack = registry.rollbackLineage({ revision: 3, target: 3 })
  assert.deepEqual(rolledBack, { revision: 4, applied: 1, revertedFrom: 3 })
  assert.equal(registry.stats().revision, 4)
  assert.equal(parentOf(registry, '2026.08.2'), null)
  const resolved = new SymbolResolver(registry).resolve(resolveRequest({
    version: '2026.08.2',
    frames: [appJsFrame]
  }))
  assert.equal(resolved.frames[0].status, 'unmapped')
})

test('rollback restores the previous parent instead of only clearing', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(childBundle())
  registry.put(bundle({ version: '2026.08.3' }))
  registry.applyLineage({ revision: 3, changes: [lineageChange()] })
  registry.applyLineage({
    revision: 4,
    changes: [lineageChange({
      parent: { application: 'mobile-shell', platform: 'android', version: '2026.08.3' }
    })]
  })
  const rolledBack = registry.rollbackLineage({ revision: 5, target: 5 })
  assert.equal(rolledBack.revision, 6)
  assert.deepEqual(parentOf(registry, '2026.08.2'), {
    application: 'mobile-shell',
    platform: 'android',
    version: '2026.08.1'
  })
  const resolved = new SymbolResolver(registry).resolve(resolveRequest({
    version: '2026.08.2',
    frames: [appJsFrame]
  }))
  assert.equal(resolved.frames[0].status, 'ancestor')
  assert.equal(resolved.frames[0].resolvedFrom, '2026.08.1')
})

test('rejects rollback of an unknown or stale base revision', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(childBundle())
  registry.applyLineage({ revision: 2, changes: [lineageChange()] })
  assert.throws(
    () => registry.rollbackLineage({ revision: 3, target: 99 }),
    (error) => error instanceof ApiError && error.statusCode === 404 && error.code === 'revision_not_found'
  )
  assert.throws(
    () => registry.rollbackLineage({ revision: 2, target: 3 }),
    (error) => error instanceof ApiError && error.statusCode === 409 && error.code === 'revision_conflict'
  )
  assert.equal(registry.stats().revision, 3)
  assert.notEqual(parentOf(registry, '2026.08.2'), null)
})

test('keeps history bounded and never reuses old revision numbers', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(childBundle())
  let revision = 2
  for (let round = 0; round < 55; round += 1) {
    revision = registry.applyLineage({
      revision,
      changes: [lineageChange({ parent: round % 2 === 0
        ? { application: 'mobile-shell', platform: 'android', version: '2026.08.1' }
        : null })]
    }).revision
  }
  assert.equal(revision, 57)
  assert.throws(
    () => registry.rollbackLineage({ revision, target: 3 }),
    (error) => error instanceof ApiError && error.code === 'revision_not_found'
  )
  const rolledBack = registry.rollbackLineage({ revision, target: 8 })
  assert.equal(rolledBack.revision, 58)
})

test('in-flight snapshots finish in their own view while new requests see the switch', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(childBundle())
  registry.applyLineage({ revision: 2, changes: [lineageChange()] })
  const resolver = new SymbolResolver(registry, { cache: new ResolutionCache() })
  const request = resolveRequest({ version: '2026.08.2', frames: [appJsFrame] })

  const before = resolver.resolve(request)
  assert.equal(before.frames[0].status, 'ancestor')

  const inFlight = registry.snapshot()
  registry.applyLineage({ revision: 3, changes: [lineageChange({ parent: null })] })

  const completed = resolver.resolveSnapshot({
    identity: { application: 'mobile-shell', platform: 'android', version: '2026.08.2' },
    frames: [appJsFrame],
    snapshot: inFlight
  })
  assert.equal(completed.registryRevision, 3)
  assert.equal(completed.frames[0].status, 'ancestor')
  assert.equal(completed.frames[0].resolvedFrom, '2026.08.1')

  const after = resolver.resolve(request)
  assert.equal(after.registryRevision, 4)
  assert.equal(after.frames[0].status, 'unmapped')
})
