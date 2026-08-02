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

const defaultSchedule = () => new Promise((resolve) => setImmediate(resolve));

function abortedError() {
  return new ApiError(408, "batch_aborted", "Batch resolution was aborted");
}

export class SymbolResolver {
  constructor(
    registry,
    { cache = null, batchConcurrency = 4, schedule = defaultSchedule } = {},
  ) {
    this.registry = registry;
    this.cache = cache;
    this.batchConcurrency = Math.max(1, batchConcurrency);
    this.schedule = schedule;
  }

  async #waitTurn(signal) {
    if (signal?.aborted) throw abortedError();
    await new Promise((resolve, reject) => {
      const onAbort = () => reject(abortedError());
      signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(this.schedule()).then(
        () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      );
    });
    if (signal?.aborted) throw abortedError();
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

  async resolveBatch(body, { signal = null } = {}) {
    const requests = readBatchRequests(body);
    const snapshot = this.registry.snapshot();
    const results = new Array(requests.length);
    const groups = new Map();
    requests.forEach((item, index) => {
      let parsed;
      try {
        parsed = {
          identity: readIdentity(item),
          frames: readFrames(item.frames),
        };
      } catch (error) {
        const known = toApiError(error);
        results[index] = { index, error: known.code, message: known.message };
        return;
      }
      const key = JSON.stringify(parsed);
      const group = groups.get(key);
      if (group) group.indices.push(index);
      else groups.set(key, { ...parsed, indices: [index] });
    });
    const queue = [...groups.values()];
    const worker = async () => {
      while (queue.length > 0) {
        if (signal?.aborted) throw abortedError();
        const group = queue.shift();
        await this.#waitTurn(signal);
        try {
          group.result = this.resolveSnapshot({
            identity: group.identity,
            frames: group.frames,
            snapshot,
          });
        } catch (error) {
          const known = toApiError(error);
          group.error = { code: known.code, message: known.message };
        }
      }
    };
    try {
      await Promise.all(
        Array.from(
          { length: Math.min(this.batchConcurrency, queue.length) },
          worker,
        ),
      );
    } catch (error) {
      queue.length = 0;
      groups.clear();
      throw error;
    }
    for (const group of groups.values()) {
      for (const index of group.indices) {
        results[index] = group.error
          ? { index, error: group.error.code, message: group.error.message }
          : { index, ...copy(group.result) };
      }
    }
    return { registryRevision: snapshot.revision, results };
  }
}
