import { createHash } from "node:crypto";
import { ApiError, toApiError } from "./errors.mjs";
import { RegistrySnapshot } from "./registry-snapshot.mjs";
import {
  computeImpact,
  planAddition,
  planRollback,
} from "./lineage-engine.mjs";
import {
  bundleKey,
  positionKey,
  readIdentity,
  readLineageRequest,
  readRollbackRequest,
  readMappings,
} from "./validation.mjs";

const copy = (value) => structuredClone(value);
const HISTORY_LIMIT = 64;

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

export class BundleRegistry {
  #state = {
    revision: 0,
    bundles: new Map(),
    artifacts: new Map(),
    lineage: new Map(),
    history: [{ revision: 0, lineage: new Map() }],
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
    // A bundle upload never changes lineage, so history carries forward as-is.
    this.#state = { ...previous, revision: nextRevision, bundles, artifacts };
    return {
      ...identity,
      revision: nextRevision,
      mappingCount: mappings.length,
      bundleDigest: digest,
      reusedContent: previous.artifacts.has(digest),
    };
  }

  previewLineage(body) {
    const request = readLineageRequest(body);
    const previous = this.#state;
    const scope = {
      application: request.application,
      platform: request.platform,
    };
    try {
      this.#assertRevision(previous, request.expectedRevision);
      const { nextLineage, changeCount } = planAddition({
        bundles: previous.bundles,
        lineage: previous.lineage,
        scope,
        relations: request.relations,
      });
      const impact = computeImpact({
        bundles: previous.bundles,
        scope,
        before: previous.lineage,
        after: nextLineage,
      });
      return {
        ...scope,
        basedOnRevision: previous.revision,
        ok: true,
        rejection: null,
        changeCount,
        impact,
      };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const known = toApiError(error);
      return {
        ...scope,
        basedOnRevision: previous.revision,
        ok: false,
        rejection: { code: known.code, message: known.message },
        changeCount: 0,
        impact: [],
      };
    }
  }

  applyLineage(body) {
    const request = readLineageRequest(body);
    const previous = this.#state;
    const scope = {
      application: request.application,
      platform: request.platform,
    };
    this.#assertRevision(previous, request.expectedRevision);
    const { nextLineage, changeCount } = planAddition({
      bundles: previous.bundles,
      lineage: previous.lineage,
      scope,
      relations: request.relations,
    });
    return this.#commitLineage(previous, scope, nextLineage, {
      operation: "apply",
      changeCount,
    });
  }

  rollbackLineage(body) {
    const request = readRollbackRequest(body);
    const previous = this.#state;
    const scope = {
      application: request.application,
      platform: request.platform,
    };
    this.#assertRevision(previous, request.expectedRevision);
    if (request.toRevision > previous.revision) {
      throw new ApiError(
        422,
        "unknown_target_revision",
        `Revision ${request.toRevision} does not exist yet`,
      );
    }
    const checkpoint = this.#historyAt(previous, request.toRevision);
    const { nextLineage, changeCount } = planRollback({
      bundles: previous.bundles,
      lineage: previous.lineage,
      scope,
      targetLineage: checkpoint.lineage,
    });
    return this.#commitLineage(previous, scope, nextLineage, {
      operation: "rollback",
      changeCount,
      restoredFromRevision: request.toRevision,
    });
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
      historyDepth: this.#state.history.length,
    };
  }

  #assertRevision(previous, expectedRevision) {
    if (expectedRevision !== previous.revision) {
      throw new ApiError(
        409,
        "revision_conflict",
        `Registry is at revision ${previous.revision}, not ${expectedRevision}`,
      );
    }
  }

  // Returns the lineage checkpoint in effect at the requested revision: the most
  // recent recorded state at or before it. Throws when history no longer retains
  // a snapshot old enough, since we refuse to guess an evicted state.
  #historyAt(previous, toRevision) {
    let match = null;
    for (const entry of previous.history) {
      if (entry.revision <= toRevision) match = entry;
    }
    if (!match) {
      throw new ApiError(
        422,
        "revision_unavailable",
        `Revision ${toRevision} is older than the retained lineage history`,
      );
    }
    return match;
  }

  #commitLineage(previous, scope, nextLineage, meta) {
    const nextRevision = previous.revision + 1;
    const history = [
      ...previous.history,
      { revision: nextRevision, lineage: new Map(nextLineage) },
    ];
    while (history.length > HISTORY_LIMIT) history.shift();
    this.#state = {
      ...previous,
      revision: nextRevision,
      lineage: nextLineage,
      history,
    };
    return {
      ...scope,
      revision: nextRevision,
      operation: meta.operation,
      changeCount: meta.changeCount,
      lineageSize: nextLineage.size,
      ...(meta.operation === "apply"
        ? { appliedRelations: meta.changeCount }
        : {}),
      ...(meta.restoredFromRevision !== undefined
        ? { restoredFromRevision: meta.restoredFromRevision }
        : {}),
    };
  }
}
