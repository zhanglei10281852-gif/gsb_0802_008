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

function assertAcyclic(lineage) {
  for (const start of lineage.keys()) {
    const seen = new Set([start]);
    let current = lineage.get(start);
    while (current !== undefined) {
      if (seen.has(current)) {
        throw new ApiError(
          422,
          "lineage_cycle",
          "Relations would introduce a cycle in the version lineage",
        );
      }
      seen.add(current);
      current = lineage.get(current);
    }
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
    const request = readLineageRequest(body);
    const previous = this.#state;
    if (request.expectedRevision !== previous.revision) {
      throw new ApiError(
        409,
        "revision_conflict",
        `Registry is at revision ${previous.revision}, not ${request.expectedRevision}`,
      );
    }

    const scopeApplication = request.application;
    const scopePlatform = request.platform;
    const declaredChildren = new Set();
    const additions = [];

    for (const relation of request.relations) {
      if (
        relation.application !== scopeApplication ||
        relation.platform !== scopePlatform
      ) {
        throw new ApiError(
          422,
          "cross_boundary_relation",
          `Relation ${relation.version}->${relation.parent} crosses the ${scopeApplication}/${scopePlatform} boundary`,
        );
      }
      if (relation.version === relation.parent) {
        throw new ApiError(
          422,
          "lineage_cycle",
          `Relation ${relation.version}->${relation.parent} is self-referential`,
        );
      }
      const childKey = bundleKey({
        application: scopeApplication,
        platform: scopePlatform,
        version: relation.version,
      });
      const parentKey = bundleKey({
        application: scopeApplication,
        platform: scopePlatform,
        version: relation.parent,
      });
      if (!previous.bundles.has(childKey)) {
        throw new ApiError(
          422,
          "unknown_version",
          `No bundle exists for version ${relation.version}`,
        );
      }
      if (!previous.bundles.has(parentKey)) {
        throw new ApiError(
          422,
          "unknown_version",
          `No bundle exists for version ${relation.parent}`,
        );
      }
      if (declaredChildren.has(childKey)) {
        throw new ApiError(
          422,
          "duplicate_relation",
          `Version ${relation.version} is assigned more than one parent in this batch`,
        );
      }
      if (previous.lineage.get(childKey) === parentKey) {
        throw new ApiError(
          422,
          "duplicate_relation",
          `Relation ${relation.version}->${relation.parent} already exists`,
        );
      }
      declaredChildren.add(childKey);
      additions.push({ childKey, parentKey });
    }

    const lineage = new Map(previous.lineage);
    for (const { childKey, parentKey } of additions)
      lineage.set(childKey, parentKey);
    assertAcyclic(lineage);

    const nextRevision = previous.revision + 1;
    this.#state = {
      revision: nextRevision,
      bundles: previous.bundles,
      artifacts: previous.artifacts,
      lineage,
    };
    return {
      application: scopeApplication,
      platform: scopePlatform,
      revision: nextRevision,
      appliedRelations: additions.length,
      lineageSize: lineage.size,
    };
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
      lineageCount: this.#state.lineage.size,
    };
  }
}
