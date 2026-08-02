import assert from 'node:assert/strict'
import test from 'node:test'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { createApiServer } from '../src/http.mjs'
import { ResolutionCancelledError, SymbolResolver } from '../src/resolver.mjs'
import { bundle, listen, resolveRequest } from '../test-support/fixtures.mjs'

function slowServer ({ delayMs = 200 } = {}) {
  const registry = new BundleRegistry()
  registry.put(bundle({ version: '1.0.0' }))
  const resolver = new SymbolResolver(registry, {
    async executeWork ({ resolve, signal }) {
      await new Promise((workResolve, workReject) => {
        const timer = setTimeout(() => {
          try {
            workResolve(resolve())
          } catch (error) {
            workReject(error)
          }
        }, delayMs)
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(timer)
            workReject(new ResolutionCancelledError(signal.reason))
          }, { once: true })
        }
      })
    }
  })
  const server = createApiServer({ registry, resolver })
  return { registry, server }
}

test('POST /v1/resolve/batch returns 504 when resolution exceeds the timeout', async (t) => {
  process.env.BATCH_TIMEOUT_MS = '50'
  const { server } = slowServer({ delayMs: 200 })
  const baseUrl = await listen(server)
  t.after(() => {
    delete process.env.BATCH_TIMEOUT_MS
    server.close()
  })
  const response = await fetch(`${baseUrl}/v1/resolve/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [resolveRequest({ version: '1.0.0' })] })
  })
  assert.equal(response.status, 504)
  assert.equal((await response.json()).error, 'batch_timeout')
})

test('a client that disconnects mid-batch does not prevent later requests from reading new revision', async (t) => {
  const { registry, server } = slowServer({ delayMs: 150 })
  const baseUrl = await listen(server)
  t.after(() => server.close())

  const controller = new AbortController()
  const fetchPromise = fetch(`${baseUrl}/v1/resolve/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [resolveRequest({ version: '1.0.0' })], concurrency: 1 }),
    signal: controller.signal
  })
  setTimeout(() => controller.abort(), 40)
  await assert.rejects(fetchPromise, { name: 'AbortError' })

  await new Promise((resolve) => setTimeout(resolve, 180))

  registry.put(bundle({
    version: '1.1.0',
    parentVersion: '1.0.0',
    mappings: [{
      generated: { file: 'app.js', line: 10, column: 2 },
      source: { file: 'src/new.ts', line: 1, column: 0 }
    }]
  }))

  const response = await fetch(`${baseUrl}/v1/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(resolveRequest({ version: '1.1.0' }))
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.registryRevision, 2)
  assert.equal(body.frames[0].source.file, 'src/new.ts')
})
