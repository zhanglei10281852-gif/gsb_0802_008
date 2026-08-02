import { createHash } from "node:crypto";
import { ApiError } from "./errors.mjs";
import { RegistrySnapshot } from "./registry-snapshot.mjs";
import {
  bundleKey,
  positionKey,
  readIdentity,
  readLineageRequest,
  readMappings,
  readRollbackRequest,
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

function findCycle(startKey, lineage) {
  const visited = new Set([startKey]);
  let cursor = lineage.get(startKey);
  while (cursor) {
    const key = bundleKey(cursor);
    if (visited.has(key)) return true;
    visited.add(key);
    cursor = lineage.get(key);
  }
  return false;
}

function ancestorChain(startKey, lineage) {
  const chain = [];
  let cursor = lineage.get(startKey);
  while (cursor) {
    chain.push(cursor);
    cursor = lineage.get(bundleKey(cursor));
  }
  return chain;
}

const HISTORY_LIMIT = 50;

export class BundleRegistry {
  #state = {
    revision: 0,
    bundles: new Map(),
    artifacts: new Map(),
    lineage: new Map(),
  };
  #history = [];

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

  #planLineage(changes) {
    const previous = this.#state;
    const lineage = new Map(previous.lineage);
    const touched = new Set();
    const violations = [];
    const effects = [];
    changes.forEach((change, index) => {
      const key = bundleKey(change);
      if (touched.has(key)) {
        violations.push({
          code: "duplicate_relation",
          message: "The same release appears in multiple changes",
          changeIndex: index,
        });
        return;
      }
      touched.add(key);
      if (!previous.bundles.has(key)) {
        violations.push({
          code: "unknown_version",
          message: `No bundle exists for release ${change.version}`,
          changeIndex: index,
        });
        return;
      }
      if (change.parent !== null) {
        if (
          change.parent.application !== change.application ||
          change.parent.platform !== change.platform
        ) {
          violations.push({
            code: "cross_boundary_reference",
            message: "Parent must belong to the same application and platform",
            changeIndex: index,
          });
          return;
        }
        if (!previous.bundles.has(bundleKey(change.parent))) {
          violations.push({
            code: "unknown_version",
            message: `No bundle exists for parent release ${change.parent.version}`,
            changeIndex: index,
          });
          return;
        }
      }
      effects.push({
        application: change.application,
        platform: change.platform,
        version: change.version,
        from: copy(previous.lineage.get(key) ?? null),
        to: copy(change.parent),
      });
      if (change.parent === null) lineage.delete(key);
      else lineage.set(key, copy(change.parent));
    });
    if (violations.length === 0) {
      for (const key of touched) {
        if (findCycle(key, lineage)) {
          violations.push({
            code: "lineage_cycle",
            message: "Lineage changes would create a cycle",
            changeIndex: null,
          });
          break;
        }
      }
    }
    return { previous, lineage, violations, effects };
  }

  #lineageImpact(previous, lineage, effects) {
    const affectedReleases = [];
    for (const [key, descriptor] of previous.bundles) {
      const before = ancestorChain(key, previous.lineage);
      const after = ancestorChain(key, lineage);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        affectedReleases.push(copy(descriptor.identity));
      }
    }
    affectedReleases.sort((a, b) => bundleKey(a).localeCompare(bundleKey(b)));
    return { changes: effects, affectedReleases };
  }

  #commitLineage({ revision, changes }) {
    if (revision !== this.#state.revision) {
      throw new ApiError(
        409,
        "revision_conflict",
        "Registry revision has changed; reload and retry",
      );
    }
    const plan = this.#planLineage(changes);
    if (plan.violations.length > 0) {
      const first = plan.violations[0];
      throw new ApiError(400, first.code, first.message);
    }
    const nextRevision = plan.previous.revision + 1;
    this.#state = {
      revision: nextRevision,
      bundles: plan.previous.bundles,
      artifacts: plan.previous.artifacts,
      lineage: plan.lineage,
    };
    this.#history.push({
      revision: nextRevision,
      changes: copy(plan.effects),
      committedAt: new Date().toISOString(),
    });
    if (this.#history.length > HISTORY_LIMIT) {
      this.#history.splice(0, this.#history.length - HISTORY_LIMIT);
    }
    return { revision: nextRevision, applied: changes.length };
  }

  applyLineage(body) {
    const { revision, changes } = readLineageRequest(body);
    return this.#commitLineage({ revision, changes });
  }

  previewLineage(body) {
    const { revision, changes } = readLineageRequest(body);
    const plan = this.#planLineage(changes);
    const valid = plan.violations.length === 0;
    return {
      revision: this.#state.revision,
      baseRevision: revision,
      stale: revision !== this.#state.revision,
      valid,
      violations: plan.violations,
      impact: valid
        ? this.#lineageImpact(plan.previous, plan.lineage, plan.effects)
        : null,
    };
  }

  rollbackLineage(body) {
    const { revision, target } = readRollbackRequest(body);
    const entry = this.#history.find((record) => record.revision === target);
    if (!entry) {
      throw new ApiError(
        404,
        "revision_not_found",
        "No lineage change recorded at this revision",
      );
    }
    const inverse = entry.changes.map((change) => ({
      application: change.application,
      platform: change.platform,
      version: change.version,
      parent: change.from ? copy(change.from) : null,
    }));
    const committed = this.#commitLineage({ revision, changes: inverse });
    return { ...committed, revertedFrom: target };
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
