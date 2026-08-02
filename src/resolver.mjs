import { ApiError } from "./errors.mjs";
import {
  positionKey,
  readBatchItems,
  readFrames,
  readIdentity,
} from "./validation.mjs";

const copy = (value) => structuredClone(value);

const DEFAULT_CONCURRENCY = 16;
const MAX_CONCURRENCY = 32;

export class ResolutionCancelledError extends Error {
  constructor(reason) {
    super("Batch resolution was cancelled");
    this.name = "ResolutionCancelledError";
    this.reason = reason ?? null;
  }
}

function throwIfCancelled(signal) {
  if (signal?.aborted)
    throw new ResolutionCancelledError(signal.reason ?? null);
}

class Semaphore {
  #available;
  #waiters = [];

  constructor(limit) {
    this.#available = limit;
  }

  acquire(signal) {
    throwIfCancelled(signal);
    if (this.#available > 0) {
      this.#available -= 1;
      return Promise.resolve(() => this.#release());
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal };
      entry.onAbort = () => {
        const index = this.#waiters.indexOf(entry);
        if (index !== -1) this.#waiters.splice(index, 1);
        reject(new ResolutionCancelledError(signal.reason ?? null));
      };
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      this.#waiters.push(entry);
    });
  }

  #release() {
    const next = this.#waiters.shift();
    if (!next) {
      this.#available += 1;
      return;
    }
    next.signal?.removeEventListener("abort", next.onAbort);
    if (next.signal?.aborted) {
      next.reject(new ResolutionCancelledError(next.signal.reason ?? null));
      this.#release();
      return;
    }
    next.resolve(() => this.#release());
  }
}

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

function readConcurrency(value) {
  if (value === undefined || value === null) return DEFAULT_CONCURRENCY;
  if (!Number.isInteger(value) || value < 1) {
    throw new ApiError(
      400,
      "invalid_concurrency",
      "concurrency must be a positive integer",
    );
  }
  return Math.min(value, MAX_CONCURRENCY);
}

export class SymbolResolver {
  constructor(registry, { cache = null, executeWork = null } = {}) {
    this.registry = registry;
    this.cache = cache;
    this.executeWork = executeWork;
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

  async resolveBatch(body, { signal } = {}) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(
        400,
        "invalid_payload",
        "Request body must be an object",
      );
    }
    const items = readBatchItems(body.items);
    const concurrency = readConcurrency(body.concurrency);
    const snapshot = this.registry.snapshot();
    const semaphore = new Semaphore(concurrency);
    const inflight = new Map();

    try {
      const results = await Promise.all(
        items.map((item) =>
          this.#resolveItem({ item, snapshot, semaphore, inflight, signal }),
        ),
      );
      return { registryRevision: snapshot.revision, results };
    } finally {
      inflight.clear();
    }
  }

  async #resolveItem({ item, snapshot, semaphore, inflight, signal }) {
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

    const requestKey = JSON.stringify({
      identity: item.identity,
      frames: item.frames,
    });
    try {
      const resolved = await this.#deduplicate({
        requestKey,
        snapshot,
        semaphore,
        inflight,
        signal,
        item,
      });
      return { index: item.index, ...copy(resolved) };
    } catch (error) {
      if (error instanceof ResolutionCancelledError) throw error;
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
  }

  async #deduplicate({
    requestKey,
    snapshot,
    semaphore,
    inflight,
    signal,
    item,
  }) {
    const cached = this.cache?.read(snapshot.revision, requestKey);
    if (cached) return copy(cached);

    const existing = inflight.get(requestKey);
    if (existing) return existing;

    const work = this.#runUniqueWork({
      item,
      snapshot,
      semaphore,
      requestKey,
      signal,
    });
    inflight.set(requestKey, work);
    try {
      return await work;
    } finally {
      if (inflight.get(requestKey) === work) inflight.delete(requestKey);
    }
  }

  async #runUniqueWork({ item, snapshot, semaphore, requestKey, signal }) {
    const release = await semaphore.acquire(signal);
    try {
      throwIfCancelled(signal);
      if (this.executeWork) {
        const result = await this.executeWork({
          identity: item.identity,
          frames: item.frames,
          snapshot,
          signal,
          resolve: () =>
            this.resolveSnapshot({
              identity: item.identity,
              frames: item.frames,
              snapshot,
            }),
        });
        this.cache?.write(snapshot.revision, requestKey, result);
        return result;
      }
      await Promise.resolve();
      throwIfCancelled(signal);
      const result = this.resolveSnapshot({
        identity: item.identity,
        frames: item.frames,
        snapshot,
      });
      this.cache?.write(snapshot.revision, requestKey, result);
      return result;
    } finally {
      release();
    }
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
