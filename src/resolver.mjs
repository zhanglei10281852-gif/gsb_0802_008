import { ApiError, toApiError } from './errors.mjs'
import { bundleKey, positionKey, readBatchBody, readFrames, readIdentity } from './validation.mjs'

const copy = (value) => structuredClone(value)

export class SymbolResolver {
  constructor (registry, { cache = null } = {}) {
    this.registry = registry
    this.cache = cache
  }

  resolve (body) {
    const identity = readIdentity(body)
    const frames = readFrames(body.frames)
    const snapshot = this.registry.snapshot()
    const requestKey = JSON.stringify({ identity, frames })
    const cached = this.cache?.read(snapshot.revision, requestKey)
    if (cached) return cached
    const result = this.resolveSnapshot({ identity, frames, snapshot })
    this.cache?.write(snapshot.revision, requestKey, result)
    return result
  }

  resolveBatch (body) {
    const requests = readBatchBody(body)
    const snapshot = this.registry.snapshot()
    const results = requests.map((item, index) => {
      try {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new ApiError(400, 'invalid_request', 'each batch item must be an object')
        }
        const identity = readIdentity(item)
        const frames = readFrames(item.frames)
        return { index, ok: true, ...this.resolveSnapshot({ identity, frames, snapshot }) }
      } catch (error) {
        const known = toApiError(error)
        return { index, ok: false, error: { code: known.code, message: known.message } }
      }
    })
    return { registryRevision: snapshot.revision, results }
  }

  resolveSnapshot ({ identity, frames, snapshot }) {
    const chain = snapshot.walkLineage(identity)
    if (chain.length === 0) throw new ApiError(404, 'bundle_not_found', 'No bundle exists for this release')
    const exactBundle = snapshot.getBundle(chain[0])
    if (!exactBundle) throw new ApiError(404, 'bundle_not_found', 'No bundle exists for this release')

    const frameResults = frames.map((frame) => this.#resolveFrame({ frame, chain, snapshot }))

    return {
      application: identity.application,
      platform: identity.platform,
      version: identity.version,
      parentVersion: exactBundle.parentVersion,
      registryRevision: snapshot.revision,
      frames: frameResults
    }
  }

  #resolveFrame ({ frame, chain, snapshot }) {
    const targetKey = positionKey(frame)
    const visitedBundles = new Set()
    for (const ancestorIdentity of chain) {
      const aKey = bundleKey(ancestorIdentity)
      if (visitedBundles.has(aKey)) break
      visitedBundles.add(aKey)
      const bundle = snapshot.getBundle(ancestorIdentity)
      if (!bundle) continue
      const source = bundle.mappingIndex.get(targetKey)
      if (source) {
        const isExact = ancestorIdentity.version === chain[0].version
        return {
          generated: copy(frame),
          status: isExact ? 'exact' : 'ancestor',
          source: copy(source),
          resolvedFrom: ancestorIdentity.version
        }
      }
    }
    return { generated: copy(frame), status: 'unmapped', source: null, resolvedFrom: null }
  }
}
