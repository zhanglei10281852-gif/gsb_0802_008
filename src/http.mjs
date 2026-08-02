import { createServer } from 'node:http'
import { toApiError, ApiError } from './errors.mjs'

function send (response, statusCode, body) {
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

export function createApiServer ({ registry, resolver }) {
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
        send(response, 200, registry.adjustLineage(await readJson(request)))
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
        send(response, 200, resolver.resolveBatch(await readJson(request)))
        return
      }
      throw new ApiError(404, 'route_not_found', 'Route does not exist')
    } catch (error) {
      const known = toApiError(error)
      send(response, known.statusCode, { error: known.code, message: known.message })
    }
  })
}
