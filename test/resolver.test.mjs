import assert from "node:assert/strict";
import test from "node:test";
import { BundleRegistry } from "../src/bundle-registry.mjs";
import { ResolutionCache } from "../src/resolution-cache.mjs";
import { SymbolResolver } from "../src/resolver.mjs";
import { ApiError } from "../src/errors.mjs";
import {
  bundle,
  lineageRequest,
  resolveRequest,
} from "../test-support/fixtures.mjs";

function hotfixRegistry() {
  const registry = new BundleRegistry();
  registry.put(bundle());
  // The hotfix release only ships one changed mapping; everything else must
  // fall back to the declared base ancestor.
  registry.put(
    bundle({
      version: "2026.08.2",
      mappings: [
        {
          generated: { file: "checkout.js", line: 19, column: 0 },
          source: { file: "src/checkout.ts", line: 90, column: 0 },
        },
      ],
    }),
  );
  registry.applyLineage(lineageRequest({ expectedRevision: 2 }));
  return registry;
}

test("resolves exact source positions and keeps unmapped frames explicit", () => {
  const registry = new BundleRegistry();
  registry.put(bundle());
  const result = new SymbolResolver(registry).resolve(
    resolveRequest({
      frames: [
        { file: "app.js", line: 10, column: 2 },
        { file: "app.js", line: 11, column: 2 },
      ],
    }),
  );
  assert.equal(result.registryRevision, 1);
  assert.deepEqual(result.frames[0], {
    generated: { file: "app.js", line: 10, column: 2 },
    status: "exact",
    source: { file: "src/bootstrap.ts", line: 42, column: 4 },
    resolvedFrom: "2026.08.1",
  });
  assert.equal(result.frames[1].status, "unmapped");
});

test("does not resolve a request against a different application or platform", () => {
  const registry = new BundleRegistry();
  registry.put(bundle());
  const resolver = new SymbolResolver(registry);
  assert.throws(
    () => resolver.resolve(resolveRequest({ platform: "ios" })),
    (error) => error instanceof ApiError && error.code === "bundle_not_found",
  );
});

test("keeps cached results revision-scoped and detached from callers", () => {
  const registry = new BundleRegistry();
  registry.put(bundle());
  const resolver = new SymbolResolver(registry, {
    cache: new ResolutionCache({ limit: 2 }),
  });
  const first = resolver.resolve(resolveRequest());
  first.frames[0].source.file = "mutated.ts";
  const second = resolver.resolve(resolveRequest());
  assert.equal(second.frames[0].source.file, "src/bootstrap.ts");

  registry.put(
    bundle({
      mappings: [
        {
          generated: { file: "app.js", line: 10, column: 2 },
          source: { file: "src/replaced.ts", line: 7, column: 1 },
        },
      ],
    }),
  );
  const afterWrite = resolver.resolve(resolveRequest());
  assert.equal(afterWrite.registryRevision, 2);
  assert.equal(afterWrite.frames[0].source.file, "src/replaced.ts");
});

test("prefers the exact release before walking declared ancestors", () => {
  const resolver = new SymbolResolver(hotfixRegistry());
  const result = resolver.resolve(
    resolveRequest({
      version: "2026.08.2",
      frames: [{ file: "checkout.js", line: 19, column: 0 }],
    }),
  );
  assert.deepEqual(result.frames[0], {
    generated: { file: "checkout.js", line: 19, column: 0 },
    status: "exact",
    source: { file: "src/checkout.ts", line: 90, column: 0 },
    resolvedFrom: "2026.08.2",
  });
});

test("falls back to the nearest declared ancestor when the position is missing", () => {
  const resolver = new SymbolResolver(hotfixRegistry());
  const result = resolver.resolve(
    resolveRequest({
      version: "2026.08.2",
      frames: [{ file: "app.js", line: 10, column: 2 }],
    }),
  );
  assert.deepEqual(result.frames[0], {
    generated: { file: "app.js", line: 10, column: 2 },
    status: "ancestor",
    source: { file: "src/bootstrap.ts", line: 42, column: 4 },
    resolvedFrom: "2026.08.1",
  });
});

test("keeps a frame unmapped when neither the release nor its lineage matches", () => {
  const resolver = new SymbolResolver(hotfixRegistry());
  const result = resolver.resolve(
    resolveRequest({
      version: "2026.08.2",
      frames: [{ file: "unknown.js", line: 3, column: 3 }],
    }),
  );
  assert.equal(result.frames[0].status, "unmapped");
  assert.equal(result.frames[0].resolvedFrom, null);
});

test("walks a transitive lineage and reports the nearest matching ancestor", () => {
  const registry = new BundleRegistry();
  registry.put(bundle());
  registry.put(
    bundle({
      version: "2026.08.2",
      mappings: [
        {
          generated: { file: "mid.js", line: 4, column: 0 },
          source: { file: "src/mid.ts", line: 4, column: 0 },
        },
      ],
    }),
  );
  registry.put(
    bundle({
      version: "2026.08.3",
      mappings: [
        {
          generated: { file: "leaf.js", line: 7, column: 0 },
          source: { file: "src/leaf.ts", line: 7, column: 0 },
        },
      ],
    }),
  );
  registry.applyLineage(
    lineageRequest({
      expectedRevision: 3,
      relations: [
        { version: "2026.08.2", parent: "2026.08.1" },
        { version: "2026.08.3", parent: "2026.08.2" },
      ],
    }),
  );
  const resolver = new SymbolResolver(registry);
  const result = resolver.resolve(
    resolveRequest({
      version: "2026.08.3",
      frames: [
        { file: "mid.js", line: 4, column: 0 },
        { file: "app.js", line: 10, column: 2 },
      ],
    }),
  );
  assert.equal(result.frames[0].status, "ancestor");
  assert.equal(result.frames[0].resolvedFrom, "2026.08.2");
  assert.equal(result.frames[1].status, "ancestor");
  assert.equal(result.frames[1].resolvedFrom, "2026.08.1");
});

test("batch resolves over one shared snapshot and preserves input order", () => {
  const registry = hotfixRegistry();
  const resolver = new SymbolResolver(registry);
  const batch = resolver.resolveBatch({
    items: [
      resolveRequest({
        version: "2026.08.2",
        frames: [{ file: "app.js", line: 10, column: 2 }],
      }),
      resolveRequest({
        version: "2026.08.1",
        frames: [{ file: "app.js", line: 10, column: 2 }],
      }),
    ],
  });
  assert.equal(batch.registryRevision, 3);
  assert.equal(batch.results[0].index, 0);
  assert.equal(batch.results[0].ok, true);
  assert.equal(batch.results[0].frames[0].status, "ancestor");
  assert.equal(batch.results[1].index, 1);
  assert.equal(batch.results[1].frames[0].status, "exact");
});

test("batch isolates an invalid or missing item without dropping the rest", () => {
  const registry = hotfixRegistry();
  const resolver = new SymbolResolver(registry);
  const batch = resolver.resolveBatch({
    items: [
      resolveRequest({ version: "2026.08.1" }),
      resolveRequest({ platform: "ios" }),
      {
        application: "mobile-shell",
        platform: "android",
        version: "2026.08.1",
        frames: [],
      },
    ],
  });
  assert.equal(batch.results[0].ok, true);
  assert.equal(batch.results[1].ok, false);
  assert.equal(batch.results[1].index, 1);
  assert.equal(batch.results[1].error, "bundle_not_found");
  assert.equal(batch.results[2].ok, false);
  assert.equal(batch.results[2].index, 2);
  assert.equal(batch.results[2].error, "invalid_frames");
});

test("rejects a batch envelope that is not a non-empty item array", () => {
  const resolver = new SymbolResolver(hotfixRegistry());
  assert.throws(
    () => resolver.resolveBatch({ items: [] }),
    (error) => error instanceof ApiError && error.code === "invalid_batch",
  );
});
