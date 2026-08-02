import assert from "node:assert/strict";
import test from "node:test";
import { BundleRegistry } from "../src/bundle-registry.mjs";
import { createApiServer } from "../src/http.mjs";
import { SymbolResolver } from "../src/resolver.mjs";
import {
  bundle,
  childBundle,
  lineageChange,
  listen,
  resolveRequest,
} from "../test-support/fixtures.mjs";

function post(baseUrl, path, payload) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

test("creates a bundle and resolves it over the HTTP boundary", async (t) => {
  const registry = new BundleRegistry();
  const server = createApiServer({
    registry,
    resolver: new SymbolResolver(registry),
  });
  const baseUrl = await listen(server);
  t.after(() => server.close());

  const stored = await fetch(`${baseUrl}/v1/bundles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bundle()),
  });
  assert.equal(stored.status, 201);
  assert.equal((await stored.json()).mappingCount, 2);

  const resolved = await fetch(`${baseUrl}/v1/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(resolveRequest()),
  });
  assert.equal(resolved.status, 200);
  assert.equal((await resolved.json()).frames[0].status, "exact");
});

test("returns a stable error response for malformed JSON", async (t) => {
  const registry = new BundleRegistry();
  const server = createApiServer({
    registry,
    resolver: new SymbolResolver(registry),
  });
  const baseUrl = await listen(server);
  t.after(() => server.close());
  const response = await fetch(`${baseUrl}/v1/resolve`, {
    method: "POST",
    body: "{",
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_json");
});

test("commits lineage over HTTP and resolves through declared ancestors", async (t) => {
  const registry = new BundleRegistry();
  const server = createApiServer({
    registry,
    resolver: new SymbolResolver(registry),
  });
  const baseUrl = await listen(server);
  t.after(() => server.close());

  assert.equal((await post(baseUrl, "/v1/bundles", bundle())).status, 201);
  assert.equal((await post(baseUrl, "/v1/bundles", childBundle())).status, 201);

  const committed = await post(baseUrl, "/v1/lineage", {
    revision: 2,
    changes: [lineageChange()],
  });
  assert.equal(committed.status, 200);
  assert.deepEqual(await committed.json(), { revision: 3, applied: 1 });

  const resolved = await post(
    baseUrl,
    "/v1/resolve",
    resolveRequest({
      version: "2026.08.2",
      frames: [
        { file: "checkout.js", line: 19, column: 0 },
        { file: "app.js", line: 10, column: 2 },
      ],
    }),
  );
  assert.equal(resolved.status, 200);
  const body = await resolved.json();
  assert.equal(body.registryRevision, 3);
  assert.equal(body.frames[0].status, "exact");
  assert.equal(body.frames[0].resolvedFrom, "2026.08.2");
  assert.equal(body.frames[1].status, "ancestor");
  assert.equal(body.frames[1].resolvedFrom, "2026.08.1");
});

test("returns 409 for a stale lineage revision and leaves state untouched", async (t) => {
  const registry = new BundleRegistry();
  const server = createApiServer({
    registry,
    resolver: new SymbolResolver(registry),
  });
  const baseUrl = await listen(server);
  t.after(() => server.close());

  await post(baseUrl, "/v1/bundles", bundle());
  await post(baseUrl, "/v1/bundles", childBundle());

  const stale = await post(baseUrl, "/v1/lineage", {
    revision: 1,
    changes: [lineageChange()],
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, "revision_conflict");

  const resolved = await post(
    baseUrl,
    "/v1/resolve",
    resolveRequest({
      version: "2026.08.2",
      frames: [{ file: "app.js", line: 10, column: 2 }],
    }),
  );
  assert.equal((await resolved.json()).frames[0].status, "unmapped");
});

test("rejects an invalid lineage batch atomically over HTTP", async (t) => {
  const registry = new BundleRegistry();
  const server = createApiServer({
    registry,
    resolver: new SymbolResolver(registry),
  });
  const baseUrl = await listen(server);
  t.after(() => server.close());

  await post(baseUrl, "/v1/bundles", bundle());
  await post(baseUrl, "/v1/bundles", childBundle());

  const cyclic = await post(baseUrl, "/v1/lineage", {
    revision: 2,
    changes: [
      lineageChange(),
      lineageChange({
        version: "2026.08.1",
        parent: {
          application: "mobile-shell",
          platform: "android",
          version: "2026.08.2",
        },
      }),
    ],
  });
  assert.equal(cyclic.status, 400);
  assert.equal((await cyclic.json()).error, "lineage_cycle");

  const crossBoundary = await post(baseUrl, "/v1/lineage", {
    revision: 2,
    changes: [
      lineageChange({
        parent: {
          application: "mobile-shell",
          platform: "ios",
          version: "2026.08.1",
        },
      }),
    ],
  });
  assert.equal(crossBoundary.status, 400);
  assert.equal((await crossBoundary.json()).error, "cross_boundary_reference");

  const resolved = await post(
    baseUrl,
    "/v1/resolve",
    resolveRequest({
      version: "2026.08.2",
      frames: [{ file: "app.js", line: 10, column: 2 }],
    }),
  );
  assert.equal((await resolved.json()).frames[0].status, "unmapped");
});

test("serves batch diagnostics with ordered results and located per-item errors", async (t) => {
  const registry = new BundleRegistry();
  const server = createApiServer({
    registry,
    resolver: new SymbolResolver(registry),
  });
  const baseUrl = await listen(server);
  t.after(() => server.close());

  await post(baseUrl, "/v1/bundles", bundle());
  await post(baseUrl, "/v1/bundles", childBundle());
  await post(baseUrl, "/v1/lineage", {
    revision: 2,
    changes: [lineageChange()],
  });

  const batch = await post(baseUrl, "/v1/resolve/batch", {
    requests: [
      resolveRequest({
        version: "2026.08.2",
        frames: [{ file: "app.js", line: 10, column: 2 }],
      }),
      {
        platform: "android",
        version: "2026.08.2",
        frames: [{ file: "app.js", line: 10, column: 2 }],
      },
      resolveRequest({ version: "2026.09.9" }),
      resolveRequest(),
    ],
  });
  assert.equal(batch.status, 200);
  const body = await batch.json();
  assert.equal(body.registryRevision, 3);
  assert.deepEqual(
    body.results.map((entry) => entry.index),
    [0, 1, 2, 3],
  );
  assert.equal(body.results[0].frames[0].status, "ancestor");
  assert.equal(body.results[0].frames[0].resolvedFrom, "2026.08.1");
  assert.equal(body.results[1].error, "invalid_application");
  assert.equal(body.results[2].error, "bundle_not_found");
  assert.equal(body.results[3].frames[0].status, "exact");

  const empty = await post(baseUrl, "/v1/resolve/batch", { requests: [] });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error, "invalid_requests");
});

test("previews lineage changes over HTTP without mutating state", async (t) => {
  const registry = new BundleRegistry();
  const server = createApiServer({
    registry,
    resolver: new SymbolResolver(registry),
  });
  const baseUrl = await listen(server);
  t.after(() => server.close());

  await post(baseUrl, "/v1/bundles", bundle());
  await post(baseUrl, "/v1/bundles", childBundle());

  const preview = await post(baseUrl, "/v1/lineage/preview", {
    revision: 2,
    changes: [lineageChange()],
  });
  assert.equal(preview.status, 200);
  const report = await preview.json();
  assert.equal(report.revision, 2);
  assert.equal(report.stale, false);
  assert.equal(report.valid, true);
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.impact.changes[0].from, null);
  assert.deepEqual(report.impact.changes[0].to, {
    application: "mobile-shell",
    platform: "android",
    version: "2026.08.1",
  });
  assert.deepEqual(report.impact.affectedReleases, [
    { application: "mobile-shell", platform: "android", version: "2026.08.2" },
  ]);

  const rejected = await post(baseUrl, "/v1/lineage/preview", {
    revision: 2,
    changes: [
      lineageChange(),
      lineageChange({ version: "2026.09.9" }),
    ],
  });
  assert.equal(rejected.status, 200);
  const rejectedReport = await rejected.json();
  assert.equal(rejectedReport.valid, false);
  assert.equal(rejectedReport.impact, null);
  assert.deepEqual(
    rejectedReport.violations.map((violation) => violation.code),
    ["unknown_version"],
  );
  assert.equal(rejectedReport.violations[0].changeIndex, 1);

  const resolved = await post(
    baseUrl,
    "/v1/resolve",
    resolveRequest({
      version: "2026.08.2",
      frames: [{ file: "app.js", line: 10, column: 2 }],
    }),
  );
  assert.equal((await resolved.json()).frames[0].status, "unmapped");
});

test("rolls back lineage over HTTP as a new validated revision", async (t) => {
  const registry = new BundleRegistry();
  const server = createApiServer({
    registry,
    resolver: new SymbolResolver(registry),
  });
  const baseUrl = await listen(server);
  t.after(() => server.close());

  await post(baseUrl, "/v1/bundles", bundle());
  await post(baseUrl, "/v1/bundles", childBundle());
  await post(baseUrl, "/v1/lineage", {
    revision: 2,
    changes: [lineageChange()],
  });

  const stale = await post(baseUrl, "/v1/lineage/rollback", {
    revision: 2,
    target: 3,
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, "revision_conflict");

  const missing = await post(baseUrl, "/v1/lineage/rollback", {
    revision: 3,
    target: 42,
  });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "revision_not_found");

  const rolledBack = await post(baseUrl, "/v1/lineage/rollback", {
    revision: 3,
    target: 3,
  });
  assert.equal(rolledBack.status, 200);
  assert.deepEqual(await rolledBack.json(), {
    revision: 4,
    applied: 1,
    revertedFrom: 3,
  });

  const resolved = await post(
    baseUrl,
    "/v1/resolve",
    resolveRequest({
      version: "2026.08.2",
      frames: [{ file: "app.js", line: 10, column: 2 }],
    }),
  );
  const body = await resolved.json();
  assert.equal(body.registryRevision, 4);
  assert.equal(body.frames[0].status, "unmapped");
});
