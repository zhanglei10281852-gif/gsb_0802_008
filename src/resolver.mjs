import { ApiError, toApiError } from "./errors.mjs";
import {
  positionKey,
  readBatchRequests,
  readFrames,
  readIdentity,
} from "./validation.mjs";

const copy = (value) => structuredClone(value);

function resolveFrame(snapshot, bundle, identity, frame) {
  const exact = bundle.mappingIndex.get(positionKey(frame));
  if (exact) {
    return {
      generated: frame,
      status: "exact",
      source: copy(exact),
      resolvedFrom: identity.version,
    };
  }
  let ancestor = snapshot.getParent(identity);
  while (ancestor) {
    const source = snapshot
      .getBundle(ancestor)
      ?.mappingIndex.get(positionKey(frame));
    if (source) {
      return {
        generated: frame,
        status: "ancestor",
        source: copy(source),
        resolvedFrom: ancestor.version,
      };
    }
    ancestor = snapshot.getParent(ancestor);
  }
  return {
    generated: frame,
    status: "unmapped",
    source: null,
    resolvedFrom: null,
  };
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
    const result = this.resolveSnapshot({ identity, frames, snapshot });
    this.cache?.write(snapshot.revision, requestKey, result);
    return result;
  }

  resolveSnapshot({ identity, frames, snapshot }) {
    const bundle = snapshot.getBundle(identity);
    if (!bundle)
      throw new ApiError(
        404,
        "bundle_not_found",
        "No bundle exists for this release",
      );
    return {
      application: identity.application,
      platform: identity.platform,
      version: identity.version,
      registryRevision: snapshot.revision,
      frames: frames.map((frame) =>
        resolveFrame(snapshot, bundle, identity, frame),
      ),
    };
  }

  resolveBatch(body) {
    const requests = readBatchRequests(body);
    const snapshot = this.registry.snapshot();
    return {
      registryRevision: snapshot.revision,
      results: requests.map((item, index) => {
        try {
          const identity = readIdentity(item);
          const frames = readFrames(item.frames);
          return {
            index,
            ...this.resolveSnapshot({ identity, frames, snapshot }),
          };
        } catch (error) {
          const known = toApiError(error);
          return { index, error: known.code, message: known.message };
        }
      }),
    };
  }
}
