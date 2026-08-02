import { ApiError } from './errors.mjs'
import { bundleKey, positionKey, readFrames, readIdentity } from './validation.mjs'

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

  resolveSnapshot ({ identity, frames, snapshot }) {
    const bundle = snapshot.getBundle(identity)
    if (!bundle) throw new ApiError(404, 'bundle_not_found', 'No bundle exists for this release')
    return {
      application: identity.application,
      platform: identity.platform,
      version: identity.version,
      registryRevision: snapshot.revision,
      frames: frames.map((frame) => {
        const source = bundle.mappingIndex.get(positionKey(frame))
        return source
          ? { generated: frame, status: 'exact', source: copy(source), resolvedFrom: identity.version }
          : { generated: frame, status: 'unmapped', source: null, resolvedFrom: null }
      })
    }
  }
}
