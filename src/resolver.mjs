import { ApiError, toApiError } from "./errors.mjs";
import { positionKey, readFrames, readIdentity } from "./validation.mjs";

const copy = (value) => structuredClone(value);

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

  resolveBatch(body) {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !Array.isArray(body.items)
    ) {
      throw new ApiError(
        400,
        "invalid_batch",
        "items must be an array of resolve requests",
      );
    }
    if (body.items.length === 0 || body.items.length > 100) {
      throw new ApiError(
        400,
        "invalid_batch",
        "items must contain between 1 and 100 requests",
      );
    }
    const snapshot = this.registry.snapshot();
    const results = body.items.map((item, index) => {
      try {
        const identity = readIdentity(item);
        const frames = readFrames(item.frames);
        const resolved = this.resolveSnapshot({ identity, frames, snapshot });
        return { index, ok: true, ...resolved };
      } catch (error) {
        const known = toApiError(error);
        return { index, ok: false, error: known.code, message: known.message };
      }
    });
    return { registryRevision: snapshot.revision, results };
  }

  resolveSnapshot({ identity, frames, snapshot }) {
    const bundle = snapshot.getBundle(identity);
    if (!bundle)
      throw new ApiError(
        404,
        "bundle_not_found",
        "No bundle exists for this release",
      );
    const ancestorKeys = snapshot.ancestorKeys(identity);
    const ancestors = ancestorKeys
      .map((key) => snapshot.getBundleByKey(key))
      .filter((entry) => entry !== null);
    return {
      application: identity.application,
      platform: identity.platform,
      version: identity.version,
      registryRevision: snapshot.revision,
      frames: frames.map((frame) =>
        resolveFrame(frame, identity, bundle, ancestors),
      ),
    };
  }
}

function resolveFrame(frame, identity, bundle, ancestors) {
  const key = positionKey(frame);
  const exact = bundle.mappingIndex.get(key);
  if (exact) {
    return {
      generated: frame,
      status: "exact",
      source: copy(exact),
      resolvedFrom: identity.version,
    };
  }
  for (const ancestor of ancestors) {
    const source = ancestor.mappingIndex.get(key);
    if (source) {
      return {
        generated: frame,
        status: "ancestor",
        source: copy(source),
        resolvedFrom: ancestor.identity.version,
      };
    }
  }
  return {
    generated: frame,
    status: "unmapped",
    source: null,
    resolvedFrom: null,
  };
}
