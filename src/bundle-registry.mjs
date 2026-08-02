import { createHash } from 'node:crypto'
import { ApiError, toApiError } from './errors.mjs'
import { RegistrySnapshot } from './registry-snapshot.mjs'
import { bundleKey, parseBundleKey, positionKey, readIdentity, readLineageBody, readMappings, readOptionalParentVersion, readRollbackBody } from './validation.mjs'

const copy = (value) => structuredClone(value)
const HISTORY_LIMIT = 100

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

function sameBoundary (childIdentity, parentIdentity) {
  return childIdentity.application === parentIdentity.application &&
    childIdentity.platform === parentIdentity.platform
}

export class BundleRegistry {
  #state = { revision: 0, bundles: new Map(), artifacts: new Map(), parents: new Map() }
  #history = []

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

    if (parentKey) {
      this.#recordHistory({
        revision: nextRevision,
        previousRevision: previous.revision,
        kind: 'publish',
        changes: [{ ...identity, fromVersion: null, toVersion: parentVersion }],
        parents
      })
    }

    return {
      ...identity,
      parentVersion,
      revision: nextRevision,
      mappingCount: mappings.length,
      bundleDigest: digest,
      reusedContent: previous.artifacts.has(digest)
    }
  }

  previewLineage (body) {
    const { expectedRevision, relationships } = readLineageBody(body)
    const state = this.#state
    try {
      const plan = this.#planLineageChange(state, relationships)
      return {
        ok: true,
        baseRevision: state.revision,
        nextRevision: state.revision + 1,
        revisionMismatch: expectedRevision !== state.revision,
        changes: plan.changes,
        affectedReleases: plan.affectedReleases
      }
    } catch (error) {
      const known = toApiError(error)
      return {
        ok: false,
        baseRevision: state.revision,
        revisionMismatch: expectedRevision !== state.revision,
        rejection: { code: known.code, message: known.message }
      }
    }
  }

  adjustLineage (body) {
    const { expectedRevision, relationships } = readLineageBody(body)
    const previous = this.#state

    if (previous.revision !== expectedRevision) {
      throw new ApiError(412, 'revision_mismatch', `expected revision ${expectedRevision} but registry is at ${previous.revision}`)
    }

    const plan = this.#planLineageChange(previous, relationships)
    const nextRevision = previous.revision + 1
    this.#state = {
      revision: nextRevision,
      bundles: previous.bundles,
      artifacts: previous.artifacts,
      parents: plan.parents
    }
    this.#recordHistory({
      revision: nextRevision,
      previousRevision: previous.revision,
      kind: 'adjustment',
      changes: plan.changes,
      parents: plan.parents
    })
    return {
      revision: nextRevision,
      applied: relationships.length,
      changes: plan.changes,
      affectedReleases: plan.affectedReleases
    }
  }

  rollbackLineage (body) {
    const { expectedRevision, targetRevision } = readRollbackBody(body)
    const previous = this.#state

    if (previous.revision !== expectedRevision) {
      throw new ApiError(412, 'revision_mismatch', `expected revision ${expectedRevision} but registry is at ${previous.revision}`)
    }
    if (targetRevision > previous.revision) {
      throw new ApiError(400, 'invalid_target_revision', 'target revision does not exist yet')
    }

    const targetParents = this.#parentsAtRevision(targetRevision)
    const relationships = this.#diffParentsForRollback(previous, targetParents, targetRevision)

    const plan = this.#planLineageChange(previous, relationships)
    const nextRevision = previous.revision + 1
    this.#state = {
      revision: nextRevision,
      bundles: previous.bundles,
      artifacts: previous.artifacts,
      parents: plan.parents
    }
    this.#recordHistory({
      revision: nextRevision,
      previousRevision: previous.revision,
      kind: 'rollback',
      rolledBackFrom: targetRevision,
      changes: plan.changes,
      parents: plan.parents
    })
    return {
      revision: nextRevision,
      applied: relationships.length,
      targetRevision,
      changes: plan.changes,
      affectedReleases: plan.affectedReleases
    }
  }

  lineageHistory () {
    return {
      revision: this.#state.revision,
      entries: this.#history.map((entry) => ({
        revision: entry.revision,
        previousRevision: entry.previousRevision,
        kind: entry.kind,
        timestamp: entry.timestamp,
        rolledBackFrom: entry.rolledBackFrom ?? null,
        changes: entry.changes.map((change) => ({ ...change }))
      }))
    }
  }

  #planLineageChange (state, relationships) {
    const parents = new Map(state.parents)
    const changedKeys = new Set()
    const changes = []

    for (const { identity, parentVersion } of relationships) {
      const childKey = bundleKey(identity)
      if (!state.bundles.has(childKey)) {
        if (this.#existsAcrossBoundary(state, identity, identity.version)) {
          throw new ApiError(400, 'cross_boundary_reference', 'child release belongs to a different application or platform')
        }
        throw new ApiError(400, 'unknown_version', `child release ${identity.version} is not registered`)
      }

      const fromVersion = parents.has(childKey) ? parseBundleKey(parents.get(childKey)).version : null

      if (parentVersion === null) {
        if (fromVersion !== null) changes.push({ ...identity, fromVersion, toVersion: null })
        parents.delete(childKey)
        changedKeys.add(childKey)
        continue
      }

      const parentKey = bundleKey({ ...identity, version: parentVersion })
      if (childKey === parentKey) {
        throw new ApiError(400, 'invalid_relationship', 'a release cannot be its own parent')
      }
      if (!state.bundles.has(parentKey)) {
        if (this.#existsAcrossBoundary(state, identity, parentVersion)) {
          throw new ApiError(400, 'cross_boundary_reference', 'parent release exists in a different application or platform')
        }
        throw new ApiError(400, 'unknown_version', `parent release ${parentVersion} is not registered`)
      }
      if (fromVersion !== parentVersion) {
        changes.push({ ...identity, fromVersion, toVersion: parentVersion })
      }
      parents.set(childKey, parentKey)
      changedKeys.add(childKey)
    }

    for (const childKey of changedKeys) {
      this.#assertNoCycle(parents, childKey)
    }

    const affectedReleases = this.#computeAffectedReleases(state, state.parents, parents, changedKeys)
    return { parents, changes, affectedReleases }
  }

  #computeAffectedReleases (state, oldParents, newParents, changedKeys) {
    const oldDescendants = this.#collectDescendants(oldParents, changedKeys)
    const newDescendants = this.#collectDescendants(newParents, changedKeys)
    const candidates = new Set([...oldDescendants, ...newDescendants])

    const affected = []
    for (const key of candidates) {
      const descriptor = state.bundles.get(key)
      if (!descriptor) continue
      const identity = parseBundleKey(key)
      const oldPositions = this.#collectChainPositions(state, identity, oldParents)
      const newPositions = this.#collectChainPositions(state, identity, newParents)
      const allKeys = new Set([...oldPositions.keys(), ...newPositions.keys()])
      const frameChanges = []
      for (const posKey of allKeys) {
        const generated = newPositions.get(posKey) ?? oldPositions.get(posKey)
        const before = this.#resolveAgainstParents(state, identity, generated, oldParents)
        const after = this.#resolveAgainstParents(state, identity, generated, newParents)
        if (before.resolvedFrom !== after.resolvedFrom || before.status !== after.status) {
          frameChanges.push({
            generated: copy(generated),
            from: { status: before.status, resolvedFrom: before.resolvedFrom },
            to: { status: after.status, resolvedFrom: after.resolvedFrom }
          })
        }
      }
      if (frameChanges.length > 0) {
        affected.push({ application: identity.application, platform: identity.platform, version: identity.version, frameChanges })
      }
    }
    return affected
  }

  #collectDescendants (parents, startKeys) {
    const children = new Map()
    for (const [child, parent] of parents) {
      if (!children.has(parent)) children.set(parent, [])
      children.get(parent).push(child)
    }
    const result = new Set()
    const stack = [...startKeys]
    while (stack.length > 0) {
      const key = stack.pop()
      if (result.has(key)) continue
      result.add(key)
      const kids = children.get(key)
      if (kids) stack.push(...kids)
    }
    return result
  }

  #collectChainPositions (state, identity, parents) {
    const positions = new Map()
    const visited = new Set()
    let currentKey = bundleKey(identity)
    while (currentKey && !visited.has(currentKey)) {
      visited.add(currentKey)
      const descriptor = state.bundles.get(currentKey)
      if (descriptor) {
        const artifact = state.artifacts.get(descriptor.digest)
        if (artifact) {
          for (const mapping of artifact.mappings) {
            const key = positionKey(mapping.generated)
            if (!positions.has(key)) positions.set(key, mapping.generated)
          }
        }
      }
      currentKey = parents.get(currentKey)
    }
    return positions
  }

  #resolveAgainstParents (state, identity, generated, parents) {
    const targetKey = positionKey(generated)
    const startKey = bundleKey(identity)
    const visited = new Set()
    let currentKey = startKey
    while (currentKey && !visited.has(currentKey)) {
      visited.add(currentKey)
      const descriptor = state.bundles.get(currentKey)
      if (descriptor) {
        const artifact = state.artifacts.get(descriptor.digest)
        const source = artifact?.mappingIndex.get(targetKey)
        if (source) {
          const version = parseBundleKey(currentKey).version
          return {
            status: currentKey === startKey ? 'exact' : 'ancestor',
            resolvedFrom: version
          }
        }
      }
      currentKey = parents.get(currentKey)
    }
    return { status: 'unmapped', resolvedFrom: null }
  }

  #diffParentsForRollback (state, targetParents, targetRevision) {
    const relationships = []
    for (const [childKey, descriptor] of state.bundles) {
      if (descriptor.registeredAtRevision > targetRevision) continue
      const identity = parseBundleKey(childKey)
      const targetParentKey = targetParents.get(childKey)
      const targetParentVersion = targetParentKey ? parseBundleKey(targetParentKey).version : null
      const currentParentKey = state.parents.get(childKey)
      const currentParentVersion = currentParentKey ? parseBundleKey(currentParentKey).version : null
      if (targetParentVersion !== currentParentVersion) {
        relationships.push({ identity, parentVersion: targetParentVersion })
      }
    }
    return relationships
  }

  #parentsAtRevision (targetRevision) {
    let found = null
    for (let i = this.#history.length - 1; i >= 0; i--) {
      if (this.#history[i].revision <= targetRevision) {
        found = this.#history[i].parents
        break
      }
    }
    return found ? new Map(found) : new Map()
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

  #recordHistory (entry) {
    this.#history.push({
      revision: entry.revision,
      previousRevision: entry.previousRevision,
      kind: entry.kind,
      timestamp: new Date().toISOString(),
      rolledBackFrom: entry.rolledBackFrom ?? null,
      changes: entry.changes.map((change) => ({ ...change })),
      parents: entry.parents
    })
    while (this.#history.length > HISTORY_LIMIT) this.#history.shift()
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
