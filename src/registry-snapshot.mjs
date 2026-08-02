import { bundleKey } from './validation.mjs'

const copy = (value) => structuredClone(value)

function cloneArtifact (artifact) {
  return {
    digest: artifact.digest,
    mappings: copy(artifact.mappings),
    mappingIndex: new Map([...artifact.mappingIndex].map(([key, source]) => [key, copy(source)]))
  }
}

export class RegistrySnapshot {
  constructor ({ revision, bundles, artifacts, lineage }) {
    this.revision = revision
    this.bundles = new Map([...bundles].map(([key, bundle]) => [key, copy(bundle)]))
    this.artifacts = new Map([...artifacts].map(([digest, artifact]) => [digest, cloneArtifact(artifact)]))
    this.lineage = new Map(lineage)
  }

  hasBundle (identity) {
    return this.bundles.has(bundleKey(identity))
  }

  getBundle (identity) {
    const key = bundleKey(identity)
    return this.getBundleByKey(key)
  }

  getBundleByKey (key) {
    const descriptor = this.bundles.get(key)
    if (!descriptor) return null
    const artifact = this.artifacts.get(descriptor.digest)
    if (!artifact) return null
    return {
      identity: copy(descriptor.identity),
      bundleDigest: descriptor.digest,
      mappingCount: descriptor.mappingCount,
      registeredAtRevision: descriptor.registeredAtRevision,
      parentVersion: descriptor.parentVersion ?? null,
      mappings: copy(artifact.mappings),
      mappingIndex: new Map([...artifact.mappingIndex].map(([key, source]) => [key, copy(source)]))
    }
  }

  getParentKey (childKey) {
    const parentVersion = this.lineage.get(childKey)
    if (parentVersion === undefined || parentVersion === null) return null
    const parts = childKey.split('\u0000')
    return `${parts[0]}\u0000${parts[1]}\u0000${parentVersion}`
  }

  ancestorsOf (identity) {
    const chain = []
    const visited = new Set()
    let currentKey = bundleKey(identity)
    while (true) {
      if (visited.has(currentKey)) break
      visited.add(currentKey)
      const parentKey = this.getParentKey(currentKey)
      if (!parentKey) break
      const parentBundle = this.getBundleByKey(parentKey)
      if (!parentBundle) break
      chain.push(parentBundle)
      currentKey = parentKey
    }
    return chain
  }
}
