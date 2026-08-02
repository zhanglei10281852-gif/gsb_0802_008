import { createServer } from 'node:http'
import { toApiError, ApiError } from './errors.mjs'

const DEFAULT_BATCH_TIMEOUT_MS = 15000

function send (response, statusCode, body) {
  if (response.writableEnded) return
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

async function readJson (request) {
  let raw = ''
  for await (const chunk of request) {
    raw += chunk
    if (raw.length > 128 * 1024) throw new ApiError(413, 'payload_too_large', 'JSON payload exceeds 128 KiB')
  }
  if (!raw) throw new ApiError(400, 'invalid_json', 'JSON payload is required')
  try {
    return JSON.parse(raw)
  } catch {
    throw new ApiError(400, 'invalid_json', 'Request body must contain valid JSON')
  }
}

// Runs the batch under an AbortController tied to both a request timeout and the
// client connection: if the caller disconnects or times out, the signal fires so
// the resolver stops starting new work and releases its batch read resources.
async function resolveBatchRequest ({ request, response, resolver, batchTimeoutMs }) {
  const body = await readJson(request)
  const controller = new AbortController()
  const onClose = () => { if (!response.writableEnded) controller.abort() }
  const timer = setTimeout(() => controller.abort(), batchTimeoutMs)
  request.on('aborted', onClose)
  request.on('close', onClose)
  try {
    const result = await resolver.resolveBatch(body, { signal: controller.signal })
    send(response, 200, result)
  } finally {
    clearTimeout(timer)
    request.off('aborted', onClose)
    request.off('close', onClose)
  }
}

export function createApiServer ({ registry, resolver, batchTimeoutMs = DEFAULT_BATCH_TIMEOUT_MS }) {
  return createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname
      if (request.method === 'GET' && path === '/health') {
        send(response, 200, { ok: true })
        return
      }
      if (request.method === 'POST' && path === '/v1/bundles') {
        send(response, 201, registry.put(await readJson(request)))
        return
      }
      if (request.method === 'POST' && path === '/v1/lineage/preview') {
        send(response, 200, registry.previewLineage(await readJson(request)))
        return
      }
      if (request.method === 'POST' && path === '/v1/lineage/rollback') {
        send(response, 200, registry.rollbackLineage(await readJson(request)))
        return
      }
      if (request.method === 'POST' && path === '/v1/lineage') {
        send(response, 200, registry.applyLineage(await readJson(request)))
        return
      }
      if (request.method === 'POST' && path === '/v1/resolve/batch') {
        await resolveBatchRequest({ request, response, resolver, batchTimeoutMs })
        return
      }
      if (request.method === 'POST' && path === '/v1/resolve') {
        send(response, 200, resolver.resolve(await readJson(request)))
        return
      }
      throw new ApiError(404, 'route_not_found', 'Route does not exist')
    } catch (error) {
      const known = toApiError(error)
      // The connection may already be gone (client disconnect / cancellation);
      // send() is a no-op once the response has ended.
      send(response, known.statusCode, { error: known.code, message: known.message })
    }
  })
}
