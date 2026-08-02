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
  constructor ({ revision, bundles, artifacts }) {
    this.revision = revision
    this.bundles = new Map([...bundles].map(([key, bundle]) => [key, copy(bundle)]))
    this.artifacts = new Map([...artifacts].map(([digest, artifact]) => [digest, cloneArtifact(artifact)]))
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
      mappings: copy(artifact.mappings),
      mappingIndex: new Map([...artifact.mappingIndex].map(([key, source]) => [key, copy(source)]))
    }
  }
}
