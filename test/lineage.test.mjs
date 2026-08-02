import assert from 'node:assert/strict'
import test from 'node:test'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { SymbolResolver } from '../src/resolver.mjs'
import { ApiError } from '../src/errors.mjs'
import { bundle, childBundle, lineageChange, resolveRequest } from '../test-support/fixtures.mjs'

function setupRegistry () {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(childBundle())
  return registry
}

function setupLineage () {
  const registry = setupRegistry()
  registry.applyLineage({ revision: 2, changes: [lineageChange()] })
  return registry
}

test('applies a lineage batch atomically and exposes parents through snapshots', () => {
  const registry = setupRegistry()
  const result = registry.applyLineage({ revision: 2, changes: [lineageChange()] })
  assert.deepEqual(result, { revision: 3, applied: 1 })
  assert.equal(registry.stats().revision, 3)
  const snapshot = registry.snapshot()
  assert.deepEqual(snapshot.getParent({ application: 'mobile-shell', platform: 'android', version: '2026.08.2' }), {
    application: 'mobile-shell',
    platform: 'android',
    version: '2026.08.1'
  })
  assert.equal(snapshot.getParent({ application: 'mobile-shell', platform: 'android', version: '2026.08.1' }), null)
})

test('resolves frames from the nearest declared ancestor only', () => {
  const registry = setupLineage()
  const result = new SymbolResolver(registry).resolve(resolveRequest({
    version: '2026.08.2',
    frames: [
      { file: 'checkout.js', line: 19, column: 0 },
      { file: 'app.js', line: 10, column: 2 },
      { file: 'app.js', line: 999, column: 0 }
    ]
  }))
  assert.equal(result.registryRevision, 3)
  assert.deepEqual(result.frames[0], {
    generated: { file: 'checkout.js', line: 19, column: 0 },
    status: 'exact',
    source: { file: 'src/checkout-v2.ts', line: 90, column: 2 },
    resolvedFrom: '2026.08.2'
  })
  assert.deepEqual(result.frames[1], {
    generated: { file: 'app.js', line: 10, column: 2 },
    status: 'ancestor',
    source: { file: 'src/bootstrap.ts', line: 42, column: 4 },
    resolvedFrom: '2026.08.1'
  })
  assert.deepEqual(result.frames[2], {
    generated: { file: 'app.js', line: 999, column: 0 },
    status: 'unmapped',
    source: null,
    resolvedFrom: null
  })
})

test('never infers lineage from version strings or re-uploaded content', () => {
  const registry = setupRegistry()
  const resolver = new SymbolResolver(registry)
  const result = resolver.resolve(resolveRequest({
    version: '2026.08.2',
    frames: [{ file: 'app.js', line: 10, column: 2 }]
  }))
  assert.equal(result.frames[0].status, 'unmapped')
  assert.equal(result.frames[0].resolvedFrom, null)
  registry.put(bundle({ version: '2026.08.3' }))
  const reuploaded = resolver.resolve(resolveRequest({ version: '2026.08.3' }))
  assert.equal(registry.snapshot().getParent({ application: 'mobile-shell', platform: 'android', version: '2026.08.3' }), null)
  assert.equal(reuploaded.frames[0].status, 'exact')
})

test('rejects the whole batch when any change references an unknown version', () => {
  const registry = setupRegistry()
  assert.throws(
    () => registry.applyLineage({
      revision: 2,
      changes: [lineageChange(), lineageChange({ version: '2026.09.9' })]
    }),
    (error) => error instanceof ApiError && error.code === 'unknown_version'
  )
  assert.equal(registry.stats().revision, 2)
  assert.equal(registry.snapshot().getParent({ application: 'mobile-shell', platform: 'android', version: '2026.08.2' }), null)
})

test('rejects unknown parent versions', () => {
  const registry = setupRegistry()
  assert.throws(
    () => registry.applyLineage({
      revision: 2,
      changes: [lineageChange({ parent: { application: 'mobile-shell', platform: 'android', version: '2026.07.9' } })]
    }),
    (error) => error instanceof ApiError && error.code === 'unknown_version'
  )
  assert.equal(registry.stats().revision, 2)
})

test('rejects cross-boundary references without applying anything', () => {
  const registry = setupRegistry()
  assert.throws(
    () => registry.applyLineage({
      revision: 2,
      changes: [lineageChange({ parent: { application: 'mobile-shell', platform: 'ios', version: '2026.08.1' } })]
    }),
    (error) => error instanceof ApiError && error.code === 'cross_boundary_reference'
  )
  assert.equal(registry.stats().revision, 2)
  assert.equal(registry.snapshot().getParent({ application: 'mobile-shell', platform: 'android', version: '2026.08.2' }), null)
})

test('rejects duplicate relations inside one batch', () => {
  const registry = setupRegistry()
  assert.throws(
    () => registry.applyLineage({ revision: 2, changes: [lineageChange(), lineageChange()] }),
    (error) => error instanceof ApiError && error.code === 'duplicate_relation'
  )
  assert.equal(registry.stats().revision, 2)
})

test('rejects self loops and multi-step cycles', () => {
  const registry = setupRegistry()
  assert.throws(
    () => registry.applyLineage({
      revision: 2,
      changes: [lineageChange({
        version: '2026.08.1',
        parent: { application: 'mobile-shell', platform: 'android', version: '2026.08.1' }
      })]
    }),
    (error) => error instanceof ApiError && error.code === 'lineage_cycle'
  )
  assert.throws(
    () => registry.applyLineage({
      revision: 2,
      changes: [
        lineageChange(),
        lineageChange({
          version: '2026.08.1',
          parent: { application: 'mobile-shell', platform: 'android', version: '2026.08.2' }
        })
      ]
    }),
    (error) => error instanceof ApiError && error.code === 'lineage_cycle'
  )
  assert.equal(registry.stats().revision, 2)
  assert.equal(registry.snapshot().getParent({ application: 'mobile-shell', platform: 'android', version: '2026.08.2' }), null)
})

test('rejects stale base revisions without applying anything', () => {
  const registry = setupRegistry()
  assert.throws(
    () => registry.applyLineage({ revision: 1, changes: [lineageChange()] }),
    (error) => error instanceof ApiError && error.statusCode === 409 && error.code === 'revision_conflict'
  )
  assert.equal(registry.stats().revision, 2)
  assert.equal(registry.snapshot().getParent({ application: 'mobile-shell', platform: 'android', version: '2026.08.2' }), null)
})

test('clears a declared parent with a null change', () => {
  const registry = setupLineage()
  const result = registry.applyLineage({ revision: 3, changes: [lineageChange({ parent: null })] })
  assert.deepEqual(result, { revision: 4, applied: 1 })
  assert.equal(registry.snapshot().getParent({ application: 'mobile-shell', platform: 'android', version: '2026.08.2' }), null)
  const resolved = new SymbolResolver(registry).resolve(resolveRequest({
    version: '2026.08.2',
    frames: [{ file: 'app.js', line: 10, column: 2 }]
  }))
  assert.equal(resolved.frames[0].status, 'unmapped')
})

test('keeps lineage scoped per application and platform', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(childBundle())
  registry.put(bundle({ platform: 'ios' }))
  registry.applyLineage({ revision: 3, changes: [lineageChange()] })
  assert.equal(registry.snapshot().getParent({ application: 'mobile-shell', platform: 'ios', version: '2026.08.1' }), null)
})

test('serves one immutable snapshot across a batch and locates per-item failures', () => {
  const registry = setupLineage()
  const result = new SymbolResolver(registry).resolveBatch({
    requests: [
      resolveRequest({ version: '2026.08.2', frames: [{ file: 'app.js', line: 10, column: 2 }] }),
      { application: 'mobile-shell', platform: 'ios', version: '2026.08.2', frames: 'nope' },
      resolveRequest({ version: '2026.09.9' }),
      resolveRequest()
    ]
  })
  assert.equal(result.registryRevision, 3)
  assert.equal(result.results.length, 4)
  assert.deepEqual(result.results.map((entry) => entry.index), [0, 1, 2, 3])
  assert.equal(result.results[0].frames[0].status, 'ancestor')
  assert.equal(result.results[0].frames[0].resolvedFrom, '2026.08.1')
  assert.equal(result.results[0].registryRevision, 3)
  assert.equal(result.results[1].error, 'invalid_frames')
  assert.equal(result.results[2].error, 'bundle_not_found')
  assert.equal(result.results[3].frames[0].status, 'exact')
  assert.equal(result.results[3].frames[0].resolvedFrom, '2026.08.1')
})

test('rejects an invalid batch envelope', () => {
  const registry = setupLineage()
  const resolver = new SymbolResolver(registry)
  assert.throws(
    () => resolver.resolveBatch({ requests: [] }),
    (error) => error instanceof ApiError && error.code === 'invalid_requests'
  )
  assert.throws(
    () => resolver.resolveBatch(null),
    (error) => error instanceof ApiError && error.code === 'invalid_payload'
  )
})
