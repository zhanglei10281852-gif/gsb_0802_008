import { bundleKey } from "./validation.mjs";
import { ancestorChain } from "./lineage-engine.mjs";

const copy = (value) => structuredClone(value);

function cloneArtifact(artifact) {
  return {
    digest: artifact.digest,
    mappings: copy(artifact.mappings),
    mappingIndex: new Map(
      [...artifact.mappingIndex].map(([key, source]) => [key, copy(source)]),
    ),
  };
}

export class RegistrySnapshot {
  constructor({ revision, bundles, artifacts, lineage }) {
    this.revision = revision;
    this.bundles = new Map(
      [...bundles].map(([key, bundle]) => [key, copy(bundle)]),
    );
    this.artifacts = new Map(
      [...artifacts].map(([digest, artifact]) => [
        digest,
        cloneArtifact(artifact),
      ]),
    );
    this.lineage = new Map(lineage ?? []);
  }

  getBundle(identity) {
    return this.getBundleByKey(bundleKey(identity));
  }

  getBundleByKey(key) {
    const descriptor = this.bundles.get(key);
    if (!descriptor) return null;
    const artifact = this.artifacts.get(descriptor.digest);
    if (!artifact) return null;
    return {
      identity: copy(descriptor.identity),
      bundleDigest: descriptor.digest,
      mappingCount: descriptor.mappingCount,
      registeredAtRevision: descriptor.registeredAtRevision,
      mappings: copy(artifact.mappings),
      mappingIndex: new Map(
        [...artifact.mappingIndex].map(([key, source]) => [key, copy(source)]),
      ),
    };
  }

  ancestorKeys(identity) {
    return ancestorChain(this.lineage, bundleKey(identity));
  }
}
