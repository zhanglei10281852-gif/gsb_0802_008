import { bundleKey, parseBundleKey } from './validation.mjs'

const copy = (value) => structuredClone(value)

function cloneArtifact (artifact) {
  return {
    digest: artifact.digest,
    mappings: copy(artifact.mappings),
    mappingIndex: new Map([...artifact.mappingIndex].map(([key, source]) => [key, copy(source)]))
  }
}

export class RegistrySnapshot {
  constructor ({ revision, bundles, artifacts, parents }) {
    this.revision = revision
    this.bundles = new Map([...bundles].map(([key, bundle]) => [key, copy(bundle)]))
    this.artifacts = new Map([...artifacts].map(([digest, artifact]) => [digest, cloneArtifact(artifact)]))
    this.parents = new Map(parents ?? [])
  }

  getBundle (identity) {
    const descriptor = this.bundles.get(bundleKey(identity))
    if (!descriptor) return null
    const artifact = this.artifacts.get(descriptor.digest)
    if (!artifact) return null
    return {
      identity: copy(descriptor.identity),
      bundleDigest: descriptor.digest,
      mappingCount: descriptor.mappingCount,
      registeredAtRevision: descriptor.registeredAtRevision,
      parentVersion: this.getParentVersion(identity),
      mappings: copy(artifact.mappings),
      mappingIndex: new Map([...artifact.mappingIndex].map(([key, source]) => [key, copy(source)]))
    }
  }

  getParentVersion (identity) {
    const parentKey = this.parents.get(bundleKey(identity))
    return parentKey ? parseBundleKey(parentKey).version : null
  }

  walkLineage (identity) {
    const chain = []
    const visited = new Set()
    let current = bundleKey(identity)
    while (current) {
      if (visited.has(current)) break
      visited.add(current)
      const descriptor = this.bundles.get(current)
      if (!descriptor) break
      chain.push(copy(descriptor.identity))
      current = this.parents.get(current)
    }
    return chain
  }
}
