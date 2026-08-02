import { createHash } from 'node:crypto'
import { ApiError } from './errors.mjs'
import { RegistrySnapshot } from './registry-snapshot.mjs'
import {
  bundleKey,
  positionKey,
  readExpectedRevision,
  readIdentity,
  readLineageChanges,
  readMappings,
  readOptionalParentVersion
} from './validation.mjs'

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

function detectCycle (lineage, startKey, parentKey) {
  const visited = new Set([startKey])
  let cursor = parentKey
  while (cursor) {
    if (visited.has(cursor)) return true
    visited.add(cursor)
    const parentVersion = lineage.get(cursor)
    if (!parentVersion) return false
    const parts = cursor.split('\u0000')
    cursor = `${parts[0]}\u0000${parts[1]}\u0000${parentVersion}`
  }
  return false
}

export class BundleRegistry {
  #state = { revision: 0, bundles: new Map(), artifacts: new Map(), lineage: new Map() }

  put (body) {
    const identity = readIdentity(body)
    const mappings = readMappings(body.mappings)
    const parentVersion = readOptionalParentVersion(body.parentVersion)
    const key = bundleKey(identity)
    const previous = this.#state

    if (previous.bundles.has(key)) {
      throw new ApiError(409, 'release_already_exists', 'A release with this identity is already registered; re-uploading mappings is not permitted')
    }

    if (parentVersion !== null) {
      if (parentVersion === identity.version) {
        throw new ApiError(400, 'invalid_parent_version', 'A release cannot declare itself as its parent')
      }
      const parentIdentity = { application: identity.application, platform: identity.platform, version: parentVersion }
      if (!previous.bundles.has(bundleKey(parentIdentity))) {
        throw new ApiError(404, 'parent_release_not_found', `Parent release ${identity.application}/${identity.platform}/${parentVersion} does not exist`)
      }
    }

    const digest = digestMappings(mappings)
    const bundles = new Map(previous.bundles)
    const artifacts = new Map(previous.artifacts)
    const lineage = new Map(previous.lineage)
    const nextRevision = previous.revision + 1

    if (!artifacts.has(digest)) artifacts.set(digest, toArtifact(mappings, digest))
    bundles.set(key, {
      identity: copy(identity),
      digest,
      mappingCount: mappings.length,
      registeredAtRevision: nextRevision,
      parentVersion
    })
    if (parentVersion !== null) lineage.set(key, parentVersion)
    this.#state = { revision: nextRevision, bundles, artifacts, lineage }
    return {
      ...identity,
      revision: nextRevision,
      mappingCount: mappings.length,
      bundleDigest: digest,
      parentVersion,
      reusedContent: previous.artifacts.has(digest)
    }
  }

  adjustLineage (body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ApiError(400, 'invalid_payload', 'Request body must be an object')
    }
    const expectedRevision = readExpectedRevision(body.expectedRevision)
    const changes = readLineageChanges(body.changes)
    const previous = this.#state

    if (expectedRevision !== null && expectedRevision !== previous.revision) {
      throw new ApiError(409, 'revision_conflict', `Registry is at revision ${previous.revision}, expected ${expectedRevision}`)
    }

    for (const { identity, parentVersion } of changes) {
      const childKey = bundleKey(identity)
      if (!previous.bundles.has(childKey)) {
        throw new ApiError(404, 'unknown_release', `Release ${identity.application}/${identity.platform}/${identity.version} is not registered`)
      }
      if (parentVersion !== null) {
        if (parentVersion === identity.version) {
          throw new ApiError(400, 'invalid_parent_version', 'A release cannot declare itself as its parent')
        }
        const parentKey = bundleKey({ application: identity.application, platform: identity.platform, version: parentVersion })
        if (!previous.bundles.has(parentKey)) {
          throw new ApiError(404, 'unknown_parent_release', `Parent release ${identity.application}/${identity.platform}/${parentVersion} is not registered`)
        }
      }
    }

    const lineage = new Map(previous.lineage)
    for (const { identity, parentVersion } of changes) {
      const childKey = bundleKey(identity)
      if (parentVersion === null) {
        lineage.delete(childKey)
      } else {
        if (detectCycle(lineage, childKey, bundleKey({ ...identity, version: parentVersion }))) {
          throw new ApiError(409, 'lineage_cycle', `Setting parent ${parentVersion} for ${identity.version} would create a cycle`)
        }
        lineage.set(childKey, parentVersion)
      }
    }

    const nextRevision = previous.revision + 1
    this.#state = { ...previous, revision: nextRevision, lineage }
    return {
      revision: nextRevision,
      previousRevision: previous.revision,
      applied: changes.length
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
      artifactCount: this.#state.artifacts.size,
      lineageEdgeCount: this.#state.lineage.size
    }
  }
}
