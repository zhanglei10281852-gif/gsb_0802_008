import { createHash } from 'node:crypto'
import { ApiError } from './errors.mjs'
import { RegistrySnapshot } from './registry-snapshot.mjs'
import { bundleKey, positionKey, readIdentity, readMappings } from './validation.mjs'

const copy = (value) => structuredClone(value)

function digestMappings (mappings) {
  const canonical = mappings.map(({ generated, source }) => ({ generated, source }))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function toArtifact (mappings, digest) {
  return {
    digest,
    mappings: copy(mappings),
    mappingIndex: new Map(mappings.map((mapping) => [
      positionKey(mapping.generated),
      copy(mapping.source)
    ]))
  }
}

export class BundleRegistry {
  #state = { revision: 0, bundles: new Map(), artifacts: new Map() }

  put (body) {
    const identity = readIdentity(body)
    const mappings = readMappings(body.mappings)
    const key = bundleKey(identity)
    const digest = digestMappings(mappings)
    const previous = this.#state
    const bundles = new Map(previous.bundles)
    const artifacts = new Map(previous.artifacts)
    const nextRevision = previous.revision + 1

    if (!artifacts.has(digest)) artifacts.set(digest, toArtifact(mappings, digest))
    bundles.set(key, {
      identity: copy(identity),
      digest,
      mappingCount: mappings.length,
      registeredAtRevision: nextRevision
    })
    this.#state = { revision: nextRevision, bundles, artifacts }
    return {
      ...identity,
      revision: nextRevision,
      mappingCount: mappings.length,
      bundleDigest: digest,
      reusedContent: previous.artifacts.has(digest)
    }
  }

  snapshot () {
    return new RegistrySnapshot(this.#state)
  }

  requireBundle (identity) {
    const bundle = this.snapshot().getBundle(identity)
    if (!bundle) throw new ApiError(404, 'bundle_not_found', 'No bundle exists for this release')
    return bundle
  }

  stats () {
    return {
      revision: this.#state.revision,
      releaseCount: this.#state.bundles.size,
      artifactCount: this.#state.artifacts.size
    }
  }
}
