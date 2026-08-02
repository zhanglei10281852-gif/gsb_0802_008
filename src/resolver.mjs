import { ApiError, toApiError } from "./errors.mjs";
import { positionKey, readFrames, readIdentity } from "./validation.mjs";

const copy = (value) => structuredClone(value);

const DEFAULT_MAX_CONCURRENCY = 8;

export class SymbolResolver {
  constructor(
    registry,
    {
      cache = null,
      maxConcurrency = DEFAULT_MAX_CONCURRENCY,
      beforeResolve = null,
    } = {},
  ) {
    this.registry = registry;
    this.cache = cache;
    this.maxConcurrency = Math.max(1, maxConcurrency);
    this.beforeResolve = beforeResolve;
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

  // Resolves a batch under production execution control: a bounded worker pool
  // caps concurrent reads, identical items inside the same batch reuse a single
  // read (never across a registry revision), and an AbortSignal stops new work
  // and releases the batch's read reuse table. Input order, per-item errors, and
  // detached per-item results are preserved exactly as the synchronous version.
  async resolveBatch(
    body,
    {
      signal = null,
      maxConcurrency = this.maxConcurrency,
      beforeResolve = this.beforeResolve,
    } = {},
  ) {
    const items = validateBatch(body);
    throwIfAborted(signal);

    // One snapshot pins the batch to a single revision so reuse can never mix
    // old and new lineage, and later requests still observe newer revisions.
    const snapshot = this.registry.snapshot();
    const memo = new Map();
    const results = new Array(items.length);
    const workerCount = Math.min(Math.max(1, maxConcurrency), items.length);
    let cursor = 0;
    let cancelled = false;

    const readOnce = (identity, frames, requestKey) => {
      let pending = memo.get(requestKey);
      if (!pending) {
        pending = (async () => {
          if (beforeResolve)
            await beforeResolve({ identity, frames, requestKey, signal });
          return this.resolveSnapshot({ identity, frames, snapshot });
        })();
        memo.set(requestKey, pending);
      }
      return pending;
    };

    const worker = async () => {
      while (true) {
        // Stop pulling new items the moment the caller cancels or disconnects.
        if (signal?.aborted) {
          cancelled = true;
          return;
        }
        const index = cursor++;
        if (index >= items.length) return;
        try {
          const identity = readIdentity(items[index]);
          const frames = readFrames(items[index].frames);
          const requestKey = JSON.stringify({ identity, frames });
          const resolved = await readOnce(identity, frames, requestKey);
          results[index] = { index, ok: true, ...copy(resolved) };
        } catch (error) {
          const known = toApiError(error);
          results[index] = {
            index,
            ok: false,
            error: known.code,
            message: known.message,
          };
        }
      }
    };

    try {
      const workers = [];
      for (let i = 0; i < workerCount; i += 1) workers.push(worker());
      await Promise.all(workers);
      if (cancelled || signal?.aborted) throwCancelled();
      return { registryRevision: snapshot.revision, results };
    } finally {
      // Release the batch's read reuse table promptly whether we finished or
      // were cancelled, so nothing pins the snapshot's read results.
      memo.clear();
    }
  }

  resolveSnapshot({ identity, frames, snapshot }) {
    const bundle = snapshot.getBundle(identity);
    if (!bundle)
      throw new ApiError(
        404,
        "bundle_not_found",
        "No bundle exists for this release",
      );
    const ancestors = snapshot
      .ancestorKeys(identity)
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

function validateBatch(body) {
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
  return body.items;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throwCancelled();
}

function throwCancelled() {
  throw new ApiError(
    499,
    "request_cancelled",
    "Batch resolution was cancelled before completion",
  );
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
