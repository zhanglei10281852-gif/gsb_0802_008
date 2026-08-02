import { createHash } from "node:crypto";
import { ApiError } from "./errors.mjs";
import { diffLineage, planLineageChanges } from "./lineage-planning.mjs";
import { RegistrySnapshot } from "./registry-snapshot.mjs";
import {
  bundleKey,
  positionKey,
  readExpectedRevision,
  readIdentity,
  readLineageChanges,
  readMappings,
  readOptionalParentVersion,
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

function errorToApiError(error) {
  const statusByCode = {
    revision_conflict: 409,
    revision_not_in_history: 409,
    unknown_release: 404,
    unknown_parent_release: 404,
    invalid_parent_version: 400,
    lineage_cycle: 409,
  };
  return new ApiError(
    statusByCode[error.code] ?? 400,
    error.code,
    error.message,
  );
}

export class BundleRegistry {
  #state = {
    revision: 0,
    bundles: new Map(),
    artifacts: new Map(),
    lineage: new Map(),
  };
  #history = [];
  #historyLimit;

  constructor({ historyLimit = 50 } = {}) {
    this.#historyLimit = historyLimit;
    this.#history.push({ revision: 0, lineage: new Map() });
  }

  put(body) {
    const identity = readIdentity(body);
    const mappings = readMappings(body.mappings);
    const parentVersion = readOptionalParentVersion(body.parentVersion);
    const key = bundleKey(identity);
    const previous = this.#state;

    if (previous.bundles.has(key)) {
      throw new ApiError(
        409,
        "release_already_exists",
        "A release with this identity is already registered; re-uploading mappings is not permitted",
      );
    }

    if (parentVersion !== null) {
      if (parentVersion === identity.version) {
        throw new ApiError(
          400,
          "invalid_parent_version",
          "A release cannot declare itself as its parent",
        );
      }
      const parentIdentity = {
        application: identity.application,
        platform: identity.platform,
        version: parentVersion,
      };
      if (!previous.bundles.has(bundleKey(parentIdentity))) {
        throw new ApiError(
          404,
          "parent_release_not_found",
          `Parent release ${identity.application}/${identity.platform}/${parentVersion} does not exist`,
        );
      }
    }

    const digest = digestMappings(mappings);
    const bundles = new Map(previous.bundles);
    const artifacts = new Map(previous.artifacts);
    const lineage = new Map(previous.lineage);
    const nextRevision = previous.revision + 1;

    if (!artifacts.has(digest))
      artifacts.set(digest, toArtifact(mappings, digest));
    bundles.set(key, {
      identity: copy(identity),
      digest,
      mappingCount: mappings.length,
      registeredAtRevision: nextRevision,
      parentVersion,
    });
    let lineageChanged = false;
    if (parentVersion !== null) {
      lineage.set(key, parentVersion);
      lineageChanged = true;
    }
    this.#state = { revision: nextRevision, bundles, artifacts, lineage };
    if (lineageChanged) this.#recordHistory(nextRevision, lineage);
    return {
      ...identity,
      revision: nextRevision,
      mappingCount: mappings.length,
      bundleDigest: digest,
      parentVersion,
      reusedContent: previous.artifacts.has(digest),
    };
  }

  #recordHistory(revision, lineage) {
    this.#history.push({ revision, lineage: new Map(lineage) });
    while (this.#history.length > this.#historyLimit) this.#history.shift();
  }

  previewLineage(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(
        400,
        "invalid_payload",
        "Request body must be an object",
      );
    }
    const expectedRevision = readExpectedRevision(body.expectedRevision);
    const changes = readLineageChanges(body.changes);
    const plan = planLineageChanges({
      bundles: this.#state.bundles,
      lineage: this.#state.lineage,
      revision: this.#state.revision,
      expectedRevision,
      changes,
    });
    return {
      valid: plan.valid,
      currentRevision: plan.currentRevision,
      errors: plan.errors,
      affectedReleases: plan.affected,
    };
  }

  adjustLineage(body) {
    const preview = this.previewLineage(body);
    if (!preview.valid) throw errorToApiError(preview.errors[0]);
    const previous = this.#state;
    const changes = readLineageChanges(body.changes);
    const plan = planLineageChanges({
      bundles: previous.bundles,
      lineage: previous.lineage,
      revision: previous.revision,
      expectedRevision: readExpectedRevision(body.expectedRevision),
      changes,
    });
    const nextRevision = previous.revision + 1;
    this.#state = {
      ...previous,
      revision: nextRevision,
      lineage: plan.nextLineage,
    };
    this.#recordHistory(nextRevision, plan.nextLineage);
    return {
      revision: nextRevision,
      previousRevision: previous.revision,
      applied: changes.length,
      affectedReleases: preview.affectedReleases,
    };
  }

  previewRollback(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(
        400,
        "invalid_payload",
        "Request body must be an object",
      );
    }
    const expectedRevision = readExpectedRevision(body.expectedRevision);
    const toRevision = readExpectedRevision(body.toRevision);
    if (toRevision === null) {
      throw new ApiError(
        400,
        "invalid_target_revision",
        "toRevision is required",
      );
    }
    const entry = this.#history.find(
      (record) => record.revision === toRevision,
    );
    if (!entry) {
      return {
        valid: false,
        currentRevision: this.#state.revision,
        targetRevision: toRevision,
        errors: [
          {
            index: -1,
            code: "revision_not_in_history",
            message: `Revision ${toRevision} is outside the retained lineage history`,
          },
        ],
        affectedReleases: [],
        changes: [],
      };
    }
    const changes = diffLineage(this.#state.lineage, entry.lineage);
    if (changes.length === 0) {
      return {
        valid: true,
        currentRevision: this.#state.revision,
        targetRevision: toRevision,
        errors: [],
        affectedReleases: [],
        changes: [],
      };
    }
    const plan = planLineageChanges({
      bundles: this.#state.bundles,
      lineage: this.#state.lineage,
      revision: this.#state.revision,
      expectedRevision,
      changes,
    });
    return {
      valid: plan.valid,
      currentRevision: plan.currentRevision,
      targetRevision: toRevision,
      errors: plan.errors,
      affectedReleases: plan.affected,
      changes: changes.map(({ identity, parentVersion }) => ({
        ...identity,
        parentVersion,
      })),
    };
  }

  rollbackLineage(body) {
    const preview = this.previewRollback(body);
    if (!preview.valid) throw errorToApiError(preview.errors[0]);
    if (preview.changes.length === 0) {
      return {
        revision: this.#state.revision,
        previousRevision: this.#state.revision,
        targetRevision: preview.targetRevision,
        applied: 0,
        affectedReleases: [],
      };
    }
    const previous = this.#state;
    const plan = planLineageChanges({
      bundles: previous.bundles,
      lineage: previous.lineage,
      revision: previous.revision,
      expectedRevision: readExpectedRevision(body.expectedRevision),
      changes: preview.changes.map((change) => ({
        identity: {
          application: change.application,
          platform: change.platform,
          version: change.version,
        },
        parentVersion: change.parentVersion,
      })),
    });
    const nextRevision = previous.revision + 1;
    this.#state = {
      ...previous,
      revision: nextRevision,
      lineage: plan.nextLineage,
    };
    this.#recordHistory(nextRevision, plan.nextLineage);
    return {
      revision: nextRevision,
      previousRevision: previous.revision,
      targetRevision: preview.targetRevision,
      applied: preview.changes.length,
      affectedReleases: preview.affectedReleases,
    };
  }

  lineageHistory() {
    return this.#history.map(({ revision }) => revision);
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
      lineageEdgeCount: this.#state.lineage.size,
      lineageHistoryDepth: this.#history.length,
    };
  }
}
