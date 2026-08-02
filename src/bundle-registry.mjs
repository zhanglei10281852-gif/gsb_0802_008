import { createHash } from "node:crypto";
import { ApiError } from "./errors.mjs";
import { RegistrySnapshot } from "./registry-snapshot.mjs";
import {
  bundleKey,
  positionKey,
  readIdentity,
  readLineageRequest,
  readMappings,
} from "./validation.mjs";

const copy = (value) => structuredClone(value);

function digestMappings(mappings) {
  const canonical = mappings.map(({ generated, source }) => ({
    generated,
    source,
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function toArtifact(mappings, digest) {
  return {
    digest,
    mappings: copy(mappings),
    mappingIndex: new Map(
      mappings.map((mapping) => [
        positionKey(mapping.generated),
        copy(mapping.source),
      ]),
    ),
  };
}

function assertAcyclic(startKey, lineage) {
  const visited = new Set([startKey]);
  let cursor = lineage.get(startKey);
  while (cursor) {
    const key = bundleKey(cursor);
    if (visited.has(key)) {
      throw new ApiError(
        400,
        "lineage_cycle",
        "Lineage changes would create a cycle",
      );
    }
    visited.add(key);
    cursor = lineage.get(key);
  }
}

export class BundleRegistry {
  #state = {
    revision: 0,
    bundles: new Map(),
    artifacts: new Map(),
    lineage: new Map(),
  };

  put(body) {
    const identity = readIdentity(body);
    const mappings = readMappings(body.mappings);
    const key = bundleKey(identity);
    const digest = digestMappings(mappings);
    const previous = this.#state;
    const bundles = new Map(previous.bundles);
    const artifacts = new Map(previous.artifacts);
    const nextRevision = previous.revision + 1;

    if (!artifacts.has(digest))
      artifacts.set(digest, toArtifact(mappings, digest));
    bundles.set(key, {
      identity: copy(identity),
      digest,
      mappingCount: mappings.length,
      registeredAtRevision: nextRevision,
    });
    this.#state = {
      revision: nextRevision,
      bundles,
      artifacts,
      lineage: previous.lineage,
    };
    return {
      ...identity,
      revision: nextRevision,
      mappingCount: mappings.length,
      bundleDigest: digest,
      reusedContent: previous.artifacts.has(digest),
    };
  }

  applyLineage(body) {
    const { revision, changes } = readLineageRequest(body);
    const previous = this.#state;
    if (revision !== previous.revision) {
      throw new ApiError(
        409,
        "revision_conflict",
        "Registry revision has changed; reload and retry",
      );
    }
    const lineage = new Map(previous.lineage);
    const touched = new Set();
    for (const change of changes) {
      const key = bundleKey(change);
      if (touched.has(key)) {
        throw new ApiError(
          400,
          "duplicate_relation",
          "The same release appears in multiple changes",
        );
      }
      touched.add(key);
      if (!previous.bundles.has(key)) {
        throw new ApiError(
          400,
          "unknown_version",
          `No bundle exists for release ${change.version}`,
        );
      }
      if (change.parent === null) {
        lineage.delete(key);
        continue;
      }
      if (
        change.parent.application !== change.application ||
        change.parent.platform !== change.platform
      ) {
        throw new ApiError(
          400,
          "cross_boundary_reference",
          "Parent must belong to the same application and platform",
        );
      }
      if (!previous.bundles.has(bundleKey(change.parent))) {
        throw new ApiError(
          400,
          "unknown_version",
          `No bundle exists for parent release ${change.parent.version}`,
        );
      }
      lineage.set(key, copy(change.parent));
    }
    for (const key of touched) assertAcyclic(key, lineage);
    this.#state = {
      revision: previous.revision + 1,
      bundles: previous.bundles,
      artifacts: previous.artifacts,
      lineage,
    };
    return { revision: previous.revision + 1, applied: changes.length };
  }

  snapshot() {
    return new RegistrySnapshot(this.#state);
  }

  requireBundle(identity) {
    const bundle = this.snapshot().getBundle(identity);
    if (!bundle)
      throw new ApiError(
        404,
        "bundle_not_found",
        "No bundle exists for this release",
      );
    return bundle;
  }

  stats() {
    return {
      revision: this.#state.revision,
      releaseCount: this.#state.bundles.size,
      artifactCount: this.#state.artifacts.size,
    };
  }
}
