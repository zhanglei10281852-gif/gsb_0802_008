import assert from "node:assert/strict";
import test from "node:test";
import { BundleRegistry } from "../src/bundle-registry.mjs";
import { createApiServer } from "../src/http.mjs";
import { SymbolResolver } from "../src/resolver.mjs";
import {
  batchRequest,
  bundle,
  lineageRequest,
  listen,
  resolveRequest,
} from "../test-support/fixtures.mjs";

function jsonPost(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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

test("publishes lineage and resolves ancestor frames over HTTP", async (t) => {
  const registry = new BundleRegistry();
  const server = createApiServer({
    registry,
    resolver: new SymbolResolver(registry),
  });
  const baseUrl = await listen(server);
  t.after(() => server.close());

  await jsonPost(`${baseUrl}/v1/bundles`, bundle({ version: "2026.08.1" }));
  await jsonPost(
    `${baseUrl}/v1/bundles`,
    bundle({
      version: "2026.08.2",
      mappings: [
        {
          generated: { file: "new.js", line: 1, column: 0 },
          source: { file: "src/new.ts", line: 1, column: 0 },
        },
      ],
    }),
  );

  const lineage = await jsonPost(
    `${baseUrl}/v1/lineage`,
    lineageRequest({ expectedRevision: 2 }),
  );
  assert.equal(lineage.status, 200);
  assert.equal((await lineage.json()).revision, 3);

  const resolved = await jsonPost(
    `${baseUrl}/v1/resolve`,
    resolveRequest({
      version: "2026.08.2",
      frames: [
        { file: "app.js", line: 10, column: 2 },
        { file: "new.js", line: 1, column: 0 },
      ],
    }),
  );
  assert.equal(resolved.status, 200);
  const body = await resolved.json();
  assert.equal(body.frames[0].status, "ancestor");
  assert.equal(body.frames[0].resolvedFrom, "2026.08.1");
  assert.equal(body.frames[1].status, "exact");
  assert.equal(body.registryRevision, 3);
});

test("returns 412 when lineage revision does not match", async (t) => {
  const registry = new BundleRegistry();
  const server = createApiServer({
    registry,
    resolver: new SymbolResolver(registry),
  });
  const baseUrl = await listen(server);
  t.after(() => server.close());

  await jsonPost(`${baseUrl}/v1/bundles`, bundle({ version: "2026.08.1" }));
  await jsonPost(`${baseUrl}/v1/bundles`, bundle({ version: "2026.08.2" }));

  const response = await jsonPost(
    `${baseUrl}/v1/lineage`,
    lineageRequest({ expectedRevision: 99 }),
  );
  assert.equal(response.status, 412);
  assert.equal((await response.json()).error, "revision_mismatch");
});

test("rejects a cycle over HTTP and applies nothing", async (t) => {
  const registry = new BundleRegistry();
  const server = createApiServer({
    registry,
    resolver: new SymbolResolver(registry),
  });
  const baseUrl = await listen(server);
  t.after(() => server.close());

  await jsonPost(`${baseUrl}/v1/bundles`, bundle({ version: "2026.08.1" }));
  await jsonPost(
    `${baseUrl}/v1/bundles`,
    bundle({ version: "2026.08.2", parentVersion: "2026.08.1" }),
  );
  await jsonPost(
    `${baseUrl}/v1/bundles`,
    bundle({ version: "2026.08.3", parentVersion: "2026.08.2" }),
  );

  const response = await jsonPost(`${baseUrl}/v1/lineage`, {
    expectedRevision: 3,
    relationships: [
      {
        application: "mobile-shell",
        platform: "android",
        version: "2026.08.1",
        parentVersion: "2026.08.3",
      },
    ],
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "lineage_cycle");

  const resolved = await jsonPost(
    `${baseUrl}/v1/resolve`,
    resolveRequest({ version: "2026.08.1" }),
  );
  assert.equal(resolved.status, 200);
  assert.equal((await resolved.json()).parentVersion, null);
});

test("batch endpoint isolates invalid items and preserves order over HTTP", async (t) => {
  const registry = new BundleRegistry();
  const server = createApiServer({
    registry,
    resolver: new SymbolResolver(registry),
  });
  const baseUrl = await listen(server);
  t.after(() => server.close());

  await jsonPost(`${baseUrl}/v1/bundles`, bundle({ version: "2026.08.1" }));
  await jsonPost(
    `${baseUrl}/v1/bundles`,
    bundle({
      version: "2026.08.2",
      parentVersion: "2026.08.1",
      mappings: [
        {
          generated: { file: "new.js", line: 1, column: 0 },
          source: { file: "src/new.ts", line: 1, column: 0 },
        },
      ],
    }),
  );

  const response = await jsonPost(
    `${baseUrl}/v1/resolve/batch`,
    batchRequest({
      requests: [
        resolveRequest({ version: "2026.08.2" }),
        resolveRequest({ version: "9.9.9" }),
        resolveRequest({ version: "2026.08.1" }),
      ],
    }),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.registryRevision, 2);
  assert.equal(body.results[0].ok, true);
  assert.equal(body.results[0].frames[0].status, "ancestor");
  assert.equal(body.results[1].ok, false);
  assert.equal(body.results[1].index, 1);
  assert.equal(body.results[1].error.code, "bundle_not_found");
  assert.equal(body.results[2].ok, true);
});

test("rejects re-uploading an existing release with 409", async (t) => {
  const registry = new BundleRegistry();
  const server = createApiServer({
    registry,
    resolver: new SymbolResolver(registry),
  });
  const baseUrl = await listen(server);
  t.after(() => server.close());

  await jsonPost(`${baseUrl}/v1/bundles`, bundle({ version: "2026.08.1" }));
  const response = await jsonPost(
    `${baseUrl}/v1/bundles`,
    bundle({ version: "2026.08.1" }),
  );
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "bundle_already_exists");
});
