import { ApiError } from './errors.mjs'
import { bundleKey, readIdentity, readMappings } from './validation.mjs'

const copy = (value) => structuredClone(value)

export class BundleRegistry {
  #bundles = new Map()
  #revision = 0

  put (body) {
    const identity = readIdentity(body)
    const mappings = readMappings(body.mappings)
    const key = bundleKey(identity)
    const mappingIndex = new Map(mappings.map((mapping) => [
      `${mapping.generated.file}\u0000${mapping.generated.line}\u0000${mapping.generated.column}`,
      mapping.source
    ]))
    this.#bundles.set(key, {
      identity,
      mappings,
      mappingIndex
    })
    this.#revision += 1
    return { ...identity, revision: this.#revision, mappingCount: mappings.length }
  }

  snapshot () {
    const bundles = new Map()
    for (const [key, bundle] of this.#bundles) {
      bundles.set(key, {
        identity: copy(bundle.identity),
        mappings: copy(bundle.mappings),
        mappingIndex: new Map([...bundle.mappingIndex].map(([position, source]) => [position, copy(source)]))
      })
    }
    return { revision: this.#revision, bundles }
  }

  requireBundle (identity) {
    const bundle = this.#bundles.get(bundleKey(identity))
    if (!bundle) throw new ApiError(404, 'bundle_not_found', 'No bundle exists for this release')
    return bundle
  }
}
