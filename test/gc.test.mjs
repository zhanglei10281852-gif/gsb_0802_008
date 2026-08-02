import assert from 'node:assert/strict'
import test from 'node:test'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { SymbolResolver } from '../src/resolver.mjs'
import { ApiError } from '../src/errors.mjs'
import { bundle, childBundle, lineageChange, resolveRequest } from '../test-support/fixtures.mjs'

const tick = () => new Promise((resolve) => setImmediate(resolve))

function createGate () {
  const pending = []
  return {
    pending,
    schedule: () => new Promise((resolve) => pending.push(resolve)),
    releaseAll () {
      while (pending.length > 0) pending.shift()()
    }
  }
}

function uniqueBundle (version) {
  return bundle({
    version,
    mappings: [{
      generated: { file: `unique-${version}.js`, line: 1, column: 0 },
      source: { file: `unique-${version}.ts`, line: 1, column: 0 }
    }]
  })
}

const release = (version) => ({ application: 'mobile-shell', platform: 'android', version })

async function drain (resolver, gate, body, options) {
  const promise = resolver.resolveBatch(body, options)
  while (gate.pending.length > 0) {
    gate.releaseAll()
    await tick()
  }
  return promise
}

test('previews safe collection with artifact impact and touches no state', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(uniqueBundle('2026.08.3'))
  const preview = registry.previewGc({ revision: 2, releases: [release('2026.08.3')] })
  assert.equal(preview.revision, 2)
  assert.equal(preview.stale, false)
  assert.equal(preview.valid, true)
  assert.deepEqual(preview.violations, [])
  assert.deepEqual(preview.impact.removableReleases, [release('2026.08.3')])
  assert.equal(preview.impact.freedArtifacts.length, 1)
  assert.equal(registry.stats().releaseCount, 2)
  assert.equal(registry.stats().artifactCount, 2)
  assert.equal(registry.previewGc({ revision: 1, releases: [release('2026.08.3')] }).stale, true)
})

test('locates every collection violation per release', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(childBundle())
  registry.put(uniqueBundle('2026.08.3'))
  registry.applyLineage({ revision: 3, changes: [lineageChange()] })
  const preview = registry.previewGc({
    revision: 4,
    releases: [
      release('2026.08.1'),
      release('2026.08.2'),
      release('2026.09.9'),
      release('2026.08.3'),
      release('2026.08.3')
    ]
  })
  assert.equal(preview.valid, false)
  assert.equal(preview.impact, null)
  assert.deepEqual(preview.violations.map((violation) => [violation.code, violation.releaseIndex]), [
    ['lineage_referenced', 0],
    ['history_referenced', 1],
    ['unknown_version', 2],
    ['duplicate_release', 4]
  ])
  assert.equal(registry.stats().releaseCount, 3)
})

test('keeps history window protection until entries age out', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(childBundle())
  registry.put(uniqueBundle('2026.08.3'))
  registry.applyLineage({ revision: 3, changes: [lineageChange()] })
  registry.applyLineage({ revision: 4, changes: [lineageChange({ parent: null })] })

  const blocked = registry.previewGc({ revision: 5, releases: [release('2026.08.1')] })
  assert.equal(blocked.valid, false)
  assert.equal(blocked.violations[0].code, 'history_referenced')

  let revision = 5
  for (let round = 0; round < 55; round += 1) {
    revision = registry.applyLineage({
      revision,
      changes: [lineageChange({
        version: '2026.08.2',
        parent: round % 2 === 0
          ? { application: 'mobile-shell', platform: 'android', version: '2026.08.3' }
          : null
      })]
    }).revision
  }
  const allowed = registry.previewGc({ revision, releases: [release('2026.08.1')] })
  assert.equal(allowed.valid, true)
  assert.deepEqual(allowed.impact.removableReleases, [release('2026.08.1')])
})

test('blocks collection while a batch holds a read lease', async () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(childBundle())
  const gate = createGate()
  const resolver = new SymbolResolver(registry, { schedule: gate.schedule })

  const inFlight = resolver.resolveBatch({ requests: [resolveRequest()] })
  assert.equal(gate.pending.length, 1)
  const during = registry.previewGc({ revision: 2, releases: [release('2026.08.1')] })
  assert.equal(during.valid, false)
  assert.equal(during.violations[0].code, 'lease_active')

  gate.releaseAll()
  await inFlight
  const after = registry.previewGc({ revision: 2, releases: [release('2026.08.1')] })
  assert.equal(after.valid, true)

  const controller = new AbortController()
  const cancelled = resolver.resolveBatch({ requests: [resolveRequest()] }, { signal: controller.signal })
  controller.abort()
  await assert.rejects(cancelled, (error) => error.code === 'batch_aborted')
  gate.releaseAll()
  await tick()
  const released = registry.previewGc({ revision: 2, releases: [release('2026.08.1')] })
  assert.equal(released.valid, true)
})

test('commits collection only on the previewed revision and revalidates', async () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(childBundle())
  registry.put(uniqueBundle('2026.08.3'))

  assert.throws(
    () => registry.collectGarbage({ revision: 2, releases: [release('2026.08.3')] }),
    (error) => error.statusCode === 409 && error.code === 'revision_conflict'
  )
  assert.notEqual(registry.requireBundle(release('2026.08.3')), null)

  const gate = createGate()
  const resolver = new SymbolResolver(registry, { schedule: gate.schedule })
  const inFlight = resolver.resolveBatch({
    requests: [resolveRequest({
      version: '2026.08.3',
      frames: [{ file: 'unique-2026.08.3.js', line: 1, column: 0 }]
    })]
  })
  assert.throws(
    () => registry.collectGarbage({ revision: 3, releases: [release('2026.08.3')] }),
    (error) => error.statusCode === 409 && error.code === 'lease_active'
  )
  gate.releaseAll()
  await inFlight

  const committed = registry.collectGarbage({ revision: 3, releases: [release('2026.08.3')] })
  assert.equal(committed.revision, 4)
  assert.equal(committed.removed, 1)
  assert.equal(committed.freedArtifacts.length, 1)
  assert.deepEqual(registry.stats(), { revision: 4, releaseCount: 2, artifactCount: 2 })
  assert.throws(
    () => registry.requireBundle(release('2026.08.3')),
    (error) => error.code === 'bundle_not_found'
  )
  const resolved = await drain(resolver, gate, { requests: [resolveRequest()] })
  assert.equal(resolved.results[0].frames[0].status, 'exact')
})

test('sweeps orphaned artifacts left behind by replaced uploads', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  const orphanDigest = registry.requireBundle(release('2026.08.1')).bundleDigest
  registry.put(bundle({
    mappings: [{
      generated: { file: 'app.js', line: 10, column: 2 },
      source: { file: 'src/replacement.ts', line: 5, column: 1 }
    }]
  }))
  registry.put(uniqueBundle('2026.08.3'))
  assert.equal(registry.stats().artifactCount, 3)

  const preview = registry.previewGc({ revision: 3, releases: [release('2026.08.3')] })
  assert.equal(preview.valid, true)
  assert.ok(preview.impact.freedArtifacts.includes(orphanDigest))
  assert.equal(preview.impact.freedArtifacts.length, 2)

  const committed = registry.collectGarbage({ revision: 3, releases: [release('2026.08.3')] })
  assert.equal(committed.freedArtifacts.length, 2)
  assert.deepEqual(registry.stats(), { revision: 4, releaseCount: 1, artifactCount: 1 })
})

test('does not free content still shared by a remaining release', () => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  registry.put(bundle({ version: '2026.08.2' }))
  const shared = registry.requireBundle(release('2026.08.1')).bundleDigest
  const preview = registry.previewGc({ revision: 2, releases: [release('2026.08.2')] })
  assert.equal(preview.valid, true)
  assert.deepEqual(preview.impact.freedArtifacts, [])
  registry.collectGarbage({ revision: 2, releases: [release('2026.08.2')] })
  assert.equal(registry.requireBundle(release('2026.08.1')).bundleDigest, shared)
})
