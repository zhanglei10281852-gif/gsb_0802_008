# Release symbol resolver API

This backend service stores content-addressed symbol bundles for mobile and web
releases, then resolves generated stack frames to source locations for crash
processing systems. It keeps a revisioned in-memory registry, produces
detached read snapshots, uses a bounded cache scoped to the snapshot that
created each result, supports explicit release lineage with ancestor fallback,
transactional lineage preview/apply/rollback, concurrency-controlled batch
diagnosis, and safe previewable source map reclamation.

```powershell
npm ci
npm test
npm run smoke
npm start
```

## HTTP API

- `POST /v1/bundles` registers a release with an application, platform,
  version, optional `parentVersion`, and a non-empty list of source mappings.
  Identical map content is stored once. A release identity is immutable:
  re-uploading the same version is rejected with `409 release_already_exists`.
- `POST /v1/lineage/preview` previews a group of parent changes without
  mutating state. It returns `valid`, `errors`, `currentRevision`, and
  `affectedReleases`.
- `POST /v1/lineage` atomically applies a group of lineage changes guarded by
  `expectedRevision`. A new registry revision is produced only when the whole
  group passes validation.
- `POST /v1/lineage/rollback` restores the lineage shape from a retained
  history revision. It is itself a new validated, revision-guarded change; it
  never overwrites the current revision and cannot revive deleted releases or
  cross application/platform boundaries.
- `POST /v1/resolve` resolves one release with exact-first, ancestor-fallback
  semantics. Each frame reports `exact`, `ancestor`, or `unmapped`, the
  `resolvedFrom` version, and the response carries `registryRevision`.
- `POST /v1/resolve/batch` resolves many items against one immutable snapshot
  captured at batch start. Duplicate reads within the batch and revision are
  merged, per-item errors keep their index, and `concurrency` bounds the number
  of in-flight resolution reads.
- `POST /v1/gc/preview` reports which source map artifacts would be reclaimed
  and why others are retained.
- `POST /v1/gc` reclaims unreferenced artifacts, guarded by `expectedRevision`.
- `GET /health` supports process checks.

## Maintenance notes

### Revision switching

`BundleRegistry` uses copy-on-write state. Every successful publish, lineage
adjustment, rollback, or reclamation produces a new monotonically increasing
revision. Read paths capture a detached `RegistrySnapshot` at start; requests
that began before a switch complete against their own snapshot, while new
requests immediately see the new revision. Lineage preview returns rejection
reasons without changing state; apply and rollback require the caller's
`expectedRevision` to match the current revision, otherwise they fail with
`409 revision_conflict` and leave state untouched.

### History retention boundary

Lineage history is bounded (`historyLimit`, default 50). Each retained entry
stores the lineage edges and the set of artifact digests present at that
revision. Rollback targets outside the window are refused with
`409 revision_not_in_history`. The history window also pins those digests
against garbage collection so a rollback can never resolve against missing
content.

### Why batch resolution is stable

`resolveBatch` captures a single snapshot before any item executes, so all
items in a batch see the same revision and lineage even if lineage changes
concurrently. Identical `(identity, frames)` reads within the batch share one
in-flight promise; each result is deep-cloned so callers cannot mutate shared
state. Input order and per-item indices are preserved. The semaphore bounds
actual resolution work; items that fail validation or miss a bundle return a
per-item error instead of failing the whole batch.

### Cancellation and resource release

Each batch accepts an `AbortSignal`. The HTTP server aborts the signal when the
client disconnects or when `BATCH_TIMEOUT_MS` (default 30000) elapses. On
abort, queued waiters are rejected, no new resolution work starts, in-flight
work releases its semaphore permit, the batch releases its content lease, and
the in-flight deduplication map is cleared. Timeouts respond with
`504 batch_timeout`; client disconnects respond with `499 client_closed_request`
only when the connection is still writable.

### Safe reclamation

Source map artifacts are content-addressed and shared across releases. An
artifact is safe to delete only when it is not referenced by any of:

1. a current registered release;
2. a lineage history entry within the retained rollback window;
3. an active batch read lease.

`POST /v1/gc/preview` returns the reclaimable digests together with retention
counts from each of the three sources. `POST /v1/gc` requires the
`expectedRevision` seen in preview; if state changed in between it rejects with
`409 gc_revision_conflict` and deletes nothing. Artifacts are deleted
atomically on the new revision; releases and lineage are never removed by GC.

## Architecture

The project intentionally uses Node.js built-ins only. `BundleRegistry` owns
copy-on-write registry state and bounded lineage history, `RegistrySnapshot`
owns detached read views, `lineage-planning` is the single source of graph
validation and impact calculation used by preview, apply, and rollback,
`BatchLeaseManager` tracks active batch reads for GC safety, `SymbolResolver`
owns request projection and batch execution, and `ResolutionCache` only serves
results for the registry revision that produced them.
