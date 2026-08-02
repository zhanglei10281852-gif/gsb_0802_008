import assert from 'node:assert/strict'
import test from 'node:test'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { createApiServer } from '../src/http.mjs'
import { SymbolResolver } from '../src/resolver.mjs'
import { bundle, batchRequest, lineageRequest, listen, reclaimRequest, resolveRequest, rollbackRequest } from '../test-support/fixtures.mjs'

async function startServer (t) {
  const registry = new BundleRegistry()
  const resolver = new SymbolResolver(registry)
  const server = createApiServer({ registry, resolver })
  const baseUrl = await listen(server)
  t.after(() => server.close())
  return { baseUrl }
}

function post (baseUrl, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

test('creates a bundle and resolves it over the HTTP boundary', async (t) => {
  const registry = new BundleRegistry()
  const server = createApiServer({ registry, resolver: new SymbolResolver(registry) })
  const baseUrl = await listen(server)
  t.after(() => server.close())

  const stored = await fetch(`${baseUrl}/v1/bundles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bundle())
  })
  assert.equal(stored.status, 201)
  assert.equal((await stored.json()).mappingCount, 2)

  const resolved = await fetch(`${baseUrl}/v1/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(resolveRequest())
  })
  assert.equal(resolved.status, 200)
  assert.equal((await resolved.json()).frames[0].status, 'exact')
})

test('returns a stable error response for malformed JSON', async (t) => {
  const registry = new BundleRegistry()
  const server = createApiServer({ registry, resolver: new SymbolResolver(registry) })
  const baseUrl = await listen(server)
  t.after(() => server.close())
  const response = await fetch(`${baseUrl}/v1/resolve`, { method: 'POST', body: '{' })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, 'invalid_json')
})

test('declares lineage and resolves an ancestor over the HTTP boundary', async (t) => {
  const { baseUrl } = await startServer(t)
  await post(baseUrl, '/v1/bundles', bundle())
  await post(baseUrl, '/v1/bundles', bundle({
    version: '2026.08.2',
    mappings: [{
      generated: { file: 'hotfix.js', line: 1, column: 0 },
      source: { file: 'src/hotfix.ts', line: 5, column: 2 }
    }]
  }))

  const applied = await post(baseUrl, '/v1/lineage', lineageRequest({ expectedRevision: 2 }))
  assert.equal(applied.status, 200)
  assert.equal((await applied.json()).revision, 3)

  const resolved = await post(baseUrl, '/v1/resolve', resolveRequest({
    version: '2026.08.2',
    frames: [{ file: 'app.js', line: 10, column: 2 }]
  }))
  assert.equal(resolved.status, 200)
  const body = await resolved.json()
  assert.equal(body.registryRevision, 3)
  assert.equal(body.frames[0].status, 'ancestor')
  assert.equal(body.frames[0].resolvedFrom, '2026.08.1')
})

test('rejects a lineage batch on a stale expected revision', async (t) => {
  const { baseUrl } = await startServer(t)
  await post(baseUrl, '/v1/bundles', bundle())
  await post(baseUrl, '/v1/bundles', bundle({ version: '2026.08.2' }))
  const conflict = await post(baseUrl, '/v1/lineage', lineageRequest({ expectedRevision: 1 }))
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).error, 'revision_conflict')
})

test('resolves a batch over the HTTP boundary and isolates bad items', async (t) => {
  const { baseUrl } = await startServer(t)
  await post(baseUrl, '/v1/bundles', bundle())

  const response = await post(baseUrl, '/v1/resolve/batch', batchRequest({
    items: [
      resolveRequest(),
      resolveRequest({ platform: 'ios' })
    ]
  }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.registryRevision, 1)
  assert.equal(body.results[0].ok, true)
  assert.equal(body.results[0].index, 0)
  assert.equal(body.results[0].frames[0].status, 'exact')
  assert.equal(body.results[1].ok, false)
  assert.equal(body.results[1].index, 1)
  assert.equal(body.results[1].error, 'bundle_not_found')
})

test('previews lineage impact over the HTTP boundary without applying it', async (t) => {
  const { baseUrl } = await startServer(t)
  await post(baseUrl, '/v1/bundles', bundle())
  await post(baseUrl, '/v1/bundles', bundle({ version: '2026.08.2' }))

  const preview = await post(baseUrl, '/v1/lineage/preview', lineageRequest({ expectedRevision: 2 }))
  assert.equal(preview.status, 200)
  const body = await preview.json()
  assert.equal(body.ok, true)
  assert.equal(body.basedOnRevision, 2)
  assert.equal(body.impact[0].version, '2026.08.2')
  assert.deepEqual(body.impact[0].nextAncestry, ['2026.08.1'])

  // Preview did not advance the registry.
  const stale = await post(baseUrl, '/v1/lineage', lineageRequest({ expectedRevision: 1 }))
  assert.equal(stale.status, 409)
})

test('rolls back lineage over the HTTP boundary as a new revision', async (t) => {
  const { baseUrl } = await startServer(t)
  await post(baseUrl, '/v1/bundles', bundle())
  await post(baseUrl, '/v1/bundles', bundle({
    version: '2026.08.2',
    mappings: [{
      generated: { file: 'hotfix.js', line: 1, column: 0 },
      source: { file: 'src/hotfix.ts', line: 5, column: 2 }
    }]
  }))
  const applied = await (await post(baseUrl, '/v1/lineage', lineageRequest({ expectedRevision: 2 }))).json()
  assert.equal(applied.revision, 3)

  const rollback = await post(baseUrl, '/v1/lineage/rollback', rollbackRequest({ expectedRevision: 3, toRevision: 2 }))
  assert.equal(rollback.status, 200)
  const body = await rollback.json()
  assert.equal(body.operation, 'rollback')
  assert.equal(body.revision, 4)
  assert.equal(body.restoredFromRevision, 2)

  const resolved = await (await post(baseUrl, '/v1/resolve', resolveRequest({
    version: '2026.08.2',
    frames: [{ file: 'app.js', line: 10, column: 2 }]
  }))).json()
  assert.equal(resolved.registryRevision, 4)
  assert.equal(resolved.frames[0].status, 'unmapped')
})

test('aborts batch work when the client disconnects mid-flight', async (t) => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  let started = 0
  const resolver = new SymbolResolver(registry, {
    maxConcurrency: 1,
    beforeResolve: async ({ signal }) => {
      started += 1
      // Hang until the request is aborted so the client can disconnect first.
      await new Promise((resolve) => {
        if (signal.aborted) return resolve()
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
  })
  const server = createApiServer({ registry, resolver })
  const baseUrl = await listen(server)
  t.after(() => server.close())

  const controller = new AbortController()
  const inflight = fetch(`${baseUrl}/v1/resolve/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [resolveRequest(), resolveRequest({ frames: [{ file: 'x.js', line: 1, column: 0 }] })] }),
    signal: controller.signal
  })
  // Give the server a moment to begin the first item, then disconnect.
  await new Promise((resolve) => setTimeout(resolve, 50))
  controller.abort()
  await assert.rejects(inflight)
  // The pool started at most the in-flight item, never the whole batch.
  assert.ok(started <= 1, `expected disconnect to stop new work, ${started} started`)
})

test('times out a batch that runs too long and releases the response', async (t) => {
  const registry = new BundleRegistry()
  registry.put(bundle())
  const resolver = new SymbolResolver(registry, {
    maxConcurrency: 1,
    beforeResolve: async ({ signal }) => {
      await new Promise((resolve) => {
        if (signal.aborted) return resolve()
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
  })
  const server = createApiServer({ registry, resolver, batchTimeoutMs: 40 })
  const baseUrl = await listen(server)
  t.after(() => server.close())

  const response = await post(baseUrl, '/v1/resolve/batch', { items: [resolveRequest()] })
  assert.equal(response.status, 499)
  assert.equal((await response.json()).error, 'request_cancelled')
})

test('previews and applies reclamation over the HTTP boundary', async (t) => {
  const { baseUrl } = await startServer(t)
  await post(baseUrl, '/v1/bundles', bundle())
  await post(baseUrl, '/v1/bundles', bundle({
    version: '2026.08.2',
    mappings: [{
      generated: { file: 'hotfix.js', line: 1, column: 0 },
      source: { file: 'src/hotfix.ts', line: 5, column: 2 }
    }]
  }))

  const preview = await (await post(baseUrl, '/v1/reclaim/preview', reclaimRequest({ versions: ['2026.08.2'] }))).json()
  assert.equal(preview.basedOnRevision, 2)
  assert.deepEqual(preview.reclaimable.map((e) => e.version), ['2026.08.2'])
  assert.equal(preview.freedArtifacts, 1)

  const applied = await post(baseUrl, '/v1/reclaim', reclaimRequest({ versions: ['2026.08.2'], expectedRevision: preview.basedOnRevision }))
  assert.equal(applied.status, 200)
  const body = await applied.json()
  assert.equal(body.operation, 'reclaim')
  assert.equal(body.revision, 3)
  assert.equal(body.reclaimedReleases, 1)

  // The release is gone; resolving it now reports the standard not-found error.
  const resolved = await post(baseUrl, '/v1/resolve', resolveRequest({ version: '2026.08.2' }))
  assert.equal(resolved.status, 404)
  assert.equal((await resolved.json()).error, 'bundle_not_found')
})

test('rejects reclamation that is blocked or based on a stale revision', async (t) => {
  const { baseUrl } = await startServer(t)
  await post(baseUrl, '/v1/bundles', bundle())
  await post(baseUrl, '/v1/bundles', bundle({ version: '2026.08.2' }))
  await post(baseUrl, '/v1/lineage', lineageRequest({ expectedRevision: 2 }))

  const blocked = await post(baseUrl, '/v1/reclaim', reclaimRequest({ versions: ['2026.08.2'], expectedRevision: 3 }))
  assert.equal(blocked.status, 409)
  assert.equal((await blocked.json()).error, 'reclaim_blocked')

  const stale = await post(baseUrl, '/v1/reclaim', reclaimRequest({ versions: ['2026.08.1'], expectedRevision: 1 }))
  assert.equal(stale.status, 409)
  assert.equal((await stale.json()).error, 'revision_conflict')
})
