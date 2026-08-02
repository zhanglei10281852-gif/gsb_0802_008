import { ApiError } from './errors.mjs'
import { bundleKey, parseBundleKey } from './validation.mjs'

// The lineage engine is the single home for graph validation and impact
// computation. Preview, apply, and rollback all route through these helpers so
// the rules that decide whether a change is legal — and which releases it moves —
// exist in exactly one place, never duplicated in the registry or HTTP layer.

export function assertAcyclic (lineage) {
  for (const start of lineage.keys()) {
    const seen = new Set([start])
    let current = lineage.get(start)
    while (current !== undefined) {
      if (seen.has(current)) {
        throw new ApiError(422, 'lineage_cycle', 'Relations would introduce a cycle in the version lineage')
      }
      seen.add(current)
      current = lineage.get(current)
    }
  }
}

export function ancestorChain (lineage, key) {
  const chain = []
  const seen = new Set([key])
  let current = lineage.get(key)
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    chain.push(current)
    current = lineage.get(current)
  }
  return chain
}

function inScope (key, scope) {
  const parsed = parseBundleKey(key)
  return parsed.application === scope.application && parsed.platform === scope.platform
}

// Validates a set of relation additions against current state and returns the
// resulting lineage map. Throws ApiError for any boundary, existence,
// duplication, or cycle violation without mutating the input.
export function planAddition ({ bundles, lineage, scope, relations }) {
  const declaredChildren = new Set()
  const additions = []

  for (const relation of relations) {
    if (relation.application !== scope.application || relation.platform !== scope.platform) {
      throw new ApiError(422, 'cross_boundary_relation', `Relation ${relation.version}->${relation.parent} crosses the ${scope.application}/${scope.platform} boundary`)
    }
    if (relation.version === relation.parent) {
      throw new ApiError(422, 'lineage_cycle', `Relation ${relation.version}->${relation.parent} is self-referential`)
    }
    const childKey = bundleKey({ ...scope, version: relation.version })
    const parentKey = bundleKey({ ...scope, version: relation.parent })
    if (!bundles.has(childKey)) {
      throw new ApiError(422, 'unknown_version', `No bundle exists for version ${relation.version}`)
    }
    if (!bundles.has(parentKey)) {
      throw new ApiError(422, 'unknown_version', `No bundle exists for version ${relation.parent}`)
    }
    if (declaredChildren.has(childKey)) {
      throw new ApiError(422, 'duplicate_relation', `Version ${relation.version} is assigned more than one parent in this batch`)
    }
    if (lineage.get(childKey) === parentKey) {
      throw new ApiError(422, 'duplicate_relation', `Relation ${relation.version}->${relation.parent} already exists`)
    }
    declaredChildren.add(childKey)
    additions.push({ childKey, parentKey })
  }

  const nextLineage = new Map(lineage)
  for (const { childKey, parentKey } of additions) nextLineage.set(childKey, parentKey)
  assertAcyclic(nextLineage)
  return { nextLineage, changeCount: additions.length }
}

// Restores a scope's lineage to a historical snapshot as a fresh, re-validated
// change. It never revives a release that no longer exists and only ever touches
// edges inside the requested application/platform boundary.
export function planRollback ({ bundles, lineage, scope, targetLineage }) {
  const restored = [...targetLineage].filter(([childKey]) => inScope(childKey, scope))
  for (const [childKey, parentKey] of restored) {
    if (!bundles.has(childKey)) {
      throw new ApiError(422, 'unknown_version', `Cannot restore lineage for missing release ${parseBundleKey(childKey).version}`)
    }
    if (!bundles.has(parentKey)) {
      throw new ApiError(422, 'unknown_version', `Cannot restore lineage onto missing release ${parseBundleKey(parentKey).version}`)
    }
  }

  const nextLineage = new Map([...lineage].filter(([childKey]) => !inScope(childKey, scope)))
  for (const [childKey, parentKey] of restored) nextLineage.set(childKey, parentKey)
  assertAcyclic(nextLineage)
  return { nextLineage, changeCount: restored.length }
}

// Reports the releases inside the scope whose declared ancestry — and therefore
// whose resolution source — differs between the two lineage maps.
export function computeImpact ({ bundles, scope, before, after }) {
  const affected = []
  for (const key of bundles.keys()) {
    if (!inScope(key, scope)) continue
    const previousAncestry = ancestorChain(before, key).map((k) => parseBundleKey(k).version)
    const nextAncestry = ancestorChain(after, key).map((k) => parseBundleKey(k).version)
    if (JSON.stringify(previousAncestry) === JSON.stringify(nextAncestry)) continue
    const { application, platform, version } = parseBundleKey(key)
    affected.push({ application, platform, version, previousAncestry, nextAncestry })
  }
  affected.sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0))
  return affected
}
