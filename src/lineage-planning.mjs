import { bundleKey } from './validation.mjs'

function parseKey (key) {
  const [application, platform, version] = key.split('\u0000')
  return { application, platform, version }
}

function buildReverseIndex (lineage) {
  const childrenOf = new Map()
  for (const [childKey, parentVersion] of lineage) {
    const { application, platform } = parseKey(childKey)
    const parentKey = `${application}\u0000${platform}\u0000${parentVersion}`
    if (!childrenOf.has(parentKey)) childrenOf.set(parentKey, [])
    childrenOf.get(parentKey).push(childKey)
  }
  return childrenOf
}

function collectDescendants (rootKey, childrenOf) {
  const result = new Set()
  const stack = [rootKey]
  while (stack.length > 0) {
    const current = stack.pop()
    const children = childrenOf.get(current)
    if (!children) continue
    for (const child of children) {
      if (!result.has(child)) {
        result.add(child)
        stack.push(child)
      }
    }
  }
  return result
}

function wouldCycle (lineage, childKey, parentKey) {
  const visited = new Set([childKey])
  let cursor = parentKey
  while (cursor) {
    if (visited.has(cursor)) return true
    visited.add(cursor)
    const nextParentVersion = lineage.get(cursor)
    if (!nextParentVersion) return false
    const { application, platform } = parseKey(cursor)
    cursor = `${application}\u0000${platform}\u0000${nextParentVersion}`
  }
  return false
}

export function planLineageChanges ({ bundles, lineage, revision, expectedRevision, changes }) {
  const errors = []
  if (expectedRevision !== null && expectedRevision !== revision) {
    errors.push({
      index: -1,
      code: 'revision_conflict',
      message: `Registry is at revision ${revision}, expected ${expectedRevision}`
    })
  }

  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index]
    const childKey = bundleKey(change.identity)
    if (!bundles.has(childKey)) {
      errors.push({
        index,
        code: 'unknown_release',
        message: `Release ${change.identity.application}/${change.identity.platform}/${change.identity.version} is not registered`
      })
      continue
    }
    if (change.parentVersion === null) continue
    if (change.parentVersion === change.identity.version) {
      errors.push({
        index,
        code: 'invalid_parent_version',
        message: 'A release cannot declare itself as its parent'
      })
      continue
    }
    const parentKey = bundleKey({ ...change.identity, version: change.parentVersion })
    if (!bundles.has(parentKey)) {
      errors.push({
        index,
        code: 'unknown_parent_release',
        message: `Parent release ${change.identity.application}/${change.identity.platform}/${change.parentVersion} is not registered`
      })
    }
  }

  const nextLineage = new Map(lineage)
  if (errors.length === 0) {
    for (let index = 0; index < changes.length; index += 1) {
      const change = changes[index]
      const childKey = bundleKey(change.identity)
      if (change.parentVersion === null) {
        nextLineage.delete(childKey)
      } else {
        const parentKey = bundleKey({ ...change.identity, version: change.parentVersion })
        if (wouldCycle(nextLineage, childKey, parentKey)) {
          errors.push({
            index,
            code: 'lineage_cycle',
            message: `Setting parent ${change.parentVersion} for ${change.identity.version} would create a cycle`
          })
          break
        }
        nextLineage.set(childKey, change.parentVersion)
      }
    }
  }

  const affected = new Set()
  if (errors.length === 0) {
    const reverseIndex = buildReverseIndex(lineage)
    for (const change of changes) {
      const childKey = bundleKey(change.identity)
      affected.add(childKey)
      for (const descendant of collectDescendants(childKey, reverseIndex)) affected.add(descendant)
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    nextLineage: errors.length === 0 ? nextLineage : null,
    affected: errors.length === 0 ? [...affected].map(parseKey) : [],
    currentRevision: revision
  }
}

export function diffLineage (currentLineage, targetLineage) {
  const changes = []
  for (const [childKey, parentVersion] of targetLineage) {
    if (currentLineage.get(childKey) !== parentVersion) {
      const identity = parseKey(childKey)
      changes.push({ identity, parentVersion })
    }
  }
  for (const childKey of currentLineage.keys()) {
    if (!targetLineage.has(childKey)) {
      const identity = parseKey(childKey)
      changes.push({ identity, parentVersion: null })
    }
  }
  return changes
}
