import { createHash } from 'node:crypto'
import { ApiError } from './errors.mjs'
import { RegistrySnapshot } from './registry-snapshot.mjs'
import { bundleKey, parseBundleKey, readIdentity, readLineageBody, readMappings, readOptionalParentVersion } from './validation.mjs'

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

function positionKey (position) {
  return `${position.file}\u0000${position.line}\u0000${position.column}`
}

function sameBoundary (childIdentity, parentIdentity) {
  return childIdentity.application === parentIdentity.application &&
    childIdentity.platform === parentIdentity.platform
}

export class BundleRegistry {
  #state = { revision: 0, bundles: new Map(), artifacts: new Map(), parents: new Map() }

  put (body) {
    const identity = readIdentity(body)
    const mappings = readMappings(body.mappings)
    const parentVersion = readOptionalParentVersion(body.parentVersion)
    const key = bundleKey(identity)
    const previous = this.#state

    if (previous.bundles.has(key)) {
      throw new ApiError(409, 'bundle_already_exists', 'A bundle for this release already exists; re-uploading cannot replace lineage')
    }

    let parentKey = null
    if (parentVersion !== null) {
      parentKey = bundleKey({ ...identity, version: parentVersion })
      if (!previous.bundles.has(parentKey)) {
        if (this.#existsAcrossBoundary(previous, identity, parentVersion)) {
          throw new ApiError(400, 'cross_boundary_reference', 'parent release exists in a different application or platform')
        }
        throw new ApiError(400, 'unknown_version', 'parent release is not registered')
      }
    }

    const digest = digestMappings(mappings)
    const bundles = new Map(previous.bundles)
    const artifacts = new Map(previous.artifacts)
    const parents = new Map(previous.parents)
    const nextRevision = previous.revision + 1

    if (!artifacts.has(digest)) artifacts.set(digest, toArtifact(mappings, digest))
    bundles.set(key, {
      identity: copy(identity),
      digest,
      mappingCount: mappings.length,
      registeredAtRevision: nextRevision
    })
    if (parentKey) parents.set(key, parentKey)
    this.#state = { revision: nextRevision, bundles, artifacts, parents }
    return {
      ...identity,
      parentVersion,
      revision: nextRevision,
      mappingCount: mappings.length,
      bundleDigest: digest,
      reusedContent: previous.artifacts.has(digest)
    }
  }

  adjustLineage (body) {
    const { expectedRevision, relationships } = readLineageBody(body)
    const previous = this.#state

    if (previous.revision !== expectedRevision) {
      throw new ApiError(412, 'revision_mismatch', `expected revision ${expectedRevision} but registry is at ${previous.revision}`)
    }

    const parents = new Map(previous.parents)
    const changedKeys = new Set()

    for (const { identity, parentVersion } of relationships) {
      const childKey = bundleKey(identity)
      if (!previous.bundles.has(childKey)) {
        if (this.#existsAcrossBoundary(previous, identity, identity.version)) {
          throw new ApiError(400, 'cross_boundary_reference', 'child release belongs to a different application or platform')
        }
        throw new ApiError(400, 'unknown_version', `child release ${identity.version} is not registered`)
      }

      if (parentVersion === null) {
        parents.delete(childKey)
        changedKeys.add(childKey)
        continue
      }

      const parentKey = bundleKey({ ...identity, version: parentVersion })
      if (childKey === parentKey) {
        throw new ApiError(400, 'invalid_relationship', 'a release cannot be its own parent')
      }
      if (!previous.bundles.has(parentKey)) {
        if (this.#existsAcrossBoundary(previous, identity, parentVersion)) {
          throw new ApiError(400, 'cross_boundary_reference', 'parent release exists in a different application or platform')
        }
        throw new ApiError(400, 'unknown_version', `parent release ${parentVersion} is not registered`)
      }
      parents.set(childKey, parentKey)
      changedKeys.add(childKey)
    }

    for (const childKey of changedKeys) {
      this.#assertNoCycle(parents, childKey)
    }

    const nextRevision = previous.revision + 1
    this.#state = {
      revision: nextRevision,
      bundles: previous.bundles,
      artifacts: previous.artifacts,
      parents
    }
    return {
      revision: nextRevision,
      applied: relationships.length
    }
  }

  #existsAcrossBoundary (state, identity, version) {
    for (const existingKey of state.bundles.keys()) {
      const existing = parseBundleKey(existingKey)
      if (existing.version === version && !sameBoundary(identity, existing)) return true
    }
    return false
  }

  #assertNoCycle (parents, startKey) {
    const visited = new Set()
    let current = parents.get(startKey)
    while (current) {
      if (current === startKey || visited.has(current)) {
        throw new ApiError(400, 'lineage_cycle', 'lineage change would introduce a cycle')
      }
      visited.add(current)
      current = parents.get(current)
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
