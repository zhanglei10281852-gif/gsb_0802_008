import { createServer } from 'node:http'
import { toApiError, ApiError } from './errors.mjs'

function send (response, statusCode, body) {
  if (response.destroyed || response.writableEnded) return
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

export function createApiServer ({ registry, resolver, batchTimeoutMs = 0 }) {
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
      if (request.method === 'POST' && path === '/v1/lineage') {
        send(response, 200, registry.applyLineage(await readJson(request)))
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
      if (request.method === 'POST' && path === '/v1/resolve') {
        send(response, 200, resolver.resolve(await readJson(request)))
        return
      }
      if (request.method === 'POST' && path === '/v1/resolve/batch') {
        const controller = new AbortController()
        const timer = batchTimeoutMs > 0
          ? setTimeout(() => controller.abort(), batchTimeoutMs)
          : null
        response.on('close', () => {
          if (!response.writableEnded) controller.abort()
        })
        try {
          const body = await readJson(request)
          send(response, 200, await resolver.resolveBatch(body, { signal: controller.signal }))
        } finally {
          if (timer) clearTimeout(timer)
        }
        return
      }
      throw new ApiError(404, 'route_not_found', 'Route does not exist')
    } catch (error) {
      const known = toApiError(error)
      send(response, known.statusCode, { error: known.code, message: known.message })
    }
  })
}
