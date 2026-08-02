import { ApiError } from "./errors.mjs";
import {
  positionKey,
  readBatchItems,
  readFrames,
  readIdentity,
} from "./validation.mjs";

const copy = (value) => structuredClone(value);

function resolveFrameAgainst(frame, bundle) {
  const source = bundle.mappingIndex.get(positionKey(frame));
  if (source) {
    return {
      generated: copy(frame),
      status: "exact",
      source: copy(source),
      resolvedFrom: bundle.identity.version,
    };
  }
  return null;
}

export class SymbolResolver {
  constructor(registry, { cache = null } = {}) {
    this.registry = registry;
    this.cache = cache;
  }

  resolve(body) {
    const identity = readIdentity(body);
    const frames = readFrames(body.frames);
    const snapshot = this.registry.snapshot();
    const requestKey = JSON.stringify({ identity, frames });
    const cached = this.cache?.read(snapshot.revision, requestKey);
    if (cached) return cached;
    if (!snapshot.hasBundle(identity)) {
      throw new ApiError(
        404,
        "bundle_not_found",
        "No bundle exists for this release",
      );
    }
    const result = this.resolveSnapshot({ identity, frames, snapshot });
    this.cache?.write(snapshot.revision, requestKey, result);
    return result;
  }

  resolveBatch(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(
        400,
        "invalid_payload",
        "Request body must be an object",
      );
    }
    const items = readBatchItems(body.items);
    const snapshot = this.registry.snapshot();
    const results = items.map((item) => {
      if (item.error) {
        return {
          index: item.index,
          application: null,
          platform: null,
          version: null,
          registryRevision: snapshot.revision,
          error: item.error,
          frames: [],
        };
      }
      try {
        return {
          index: item.index,
          ...this.resolveSnapshot({
            identity: item.identity,
            frames: item.frames,
            snapshot,
          }),
        };
      } catch (error) {
        if (error instanceof ApiError) {
          return {
            index: item.index,
            application: item.identity.application,
            platform: item.identity.platform,
            version: item.identity.version,
            registryRevision: snapshot.revision,
            error: { code: error.code, message: error.message },
            frames: [],
          };
        }
        throw error;
      }
    });
    return { registryRevision: snapshot.revision, results };
  }

  resolveSnapshot({ identity, frames, snapshot }) {
    const exactBundle = snapshot.getBundle(identity);
    if (!exactBundle) {
      throw new ApiError(
        404,
        "bundle_not_found",
        "No bundle exists for this release",
      );
    }

    const ancestors = snapshot.ancestorsOf(identity);
    const searchBundles = [exactBundle, ...ancestors];

    const resolvedFrames = frames.map((frame) => {
      for (const bundle of searchBundles) {
        const hit = resolveFrameAgainst(frame, bundle);
        if (hit) {
          return {
            ...hit,
            status: bundle === exactBundle ? "exact" : "ancestor",
          };
        }
      }
      return {
        generated: copy(frame),
        status: "unmapped",
        source: null,
        resolvedFrom: null,
      };
    });

    return {
      application: identity.application,
      platform: identity.platform,
      version: identity.version,
      registryRevision: snapshot.revision,
      frames: resolvedFrames,
    };
  }
}
