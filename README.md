# Release symbol resolver API

This backend service stores content-addressed symbol bundles for mobile and web
releases, then resolves generated stack frames to source locations for crash
processing systems. It keeps a revisioned in-memory registry, produces
detached read snapshots, and uses a bounded cache scoped to the snapshot that
created each result. Releases may declare an explicit parent within the same
application and platform; resolution prefers the exact release and then walks
the declared lineage to the nearest ancestor.

```powershell
npm ci
npm test
npm run smoke
npm start
```

`POST /v1/bundles` accepts an application, platform, version, an optional
`parentVersion`, and a non-empty list of source mappings. Identical map content
is stored once while each release keeps its own immutable descriptor. A release
that already exists cannot be re-uploaded, so lineage cannot be bypassed by
re-submitting mappings. `POST /v1/lineage/preview` is a read-only dry run that
returns the edge changes, the releases whose resolution source would change
(frame-level `from`/`to`), and any rejection reason, without advancing the
revision. `POST /v1/lineage` atomically applies a batch of parent relationships
against an `expectedRevision` (compare-and-swap); any unknown version,
cross-boundary reference, duplicate relationship, or cycle rejects the entire
batch. `POST /v1/lineage/rollback` restores the parent graph from a prior
revision as a new, independently validated revision (it never overwrites an old
revision, never resurrects missing releases, and never crosses boundaries).
`GET /v1/lineage/history` returns the bounded lineage change log. Preview,
apply, and rollback share one graph validator and impact calculator.
`POST /v1/resolve` accepts the same release identity and one or more generated
frames, resolving exact matches first and then walking the declared lineage to
the nearest ancestor. `POST /v1/resolve/batch` resolves many requests against one immutable snapshot,
returning per-item results in input order and isolating failures to their index.
Batch execution caps in-flight work at a configurable concurrency limit
(`BATCH_CONCURRENCY`, default 8), merges identical requests within the same
snapshot so their read work runs once while every index still receives its own
result, and honours an `AbortSignal` for cancellation. The HTTP server aborts a
batch when the client disconnects or when `BATCH_TIMEOUT_MS` (default 30000)
elapses; after cancellation no new work starts, in-flight slots are released,
and unprocessed items are returned with `error.code = "cancelled"`. The captured
snapshot is fixed for the whole batch, so a concurrent lineage preview, apply,
or rollback never mixes old and new lineage within the same response, while
subsequent requests immediately read the new revision. `POST /v1/gc/preview`
reports which source-map artifacts would be collected; `POST /v1/gc` executes
collection against an `expectedRevision` (compare-and-swap). Content is only
deleted when no live release, retained history entry, or active batch lease
references it. `GET /health` supports process checks.

The project intentionally uses Node.js built-ins only. `BundleRegistry` owns
copy-on-write registry state, `RegistrySnapshot` owns detached read views,
`SymbolResolver` owns request projection and lineage walk, and
`ResolutionCache` only serves results for the registry revision that produced
them.

## Operations and maintenance

### Revision switching

Every state-changing operation (`POST /v1/bundles`, `POST /v1/lineage`,
`POST /v1/lineage/rollback`, `POST /v1/gc`) produces a new monotonically
increasing revision through copy-on-write. Read paths capture a detached
`RegistrySnapshot` at the start of a request, so a revision switch that lands
mid-request never corrupts or partially applies to an in-flight read. Callers
must supply the `expectedRevision` they based their change on; a mismatch
returns `412 revision_mismatch` and applies nothing.

### History retention boundary

The lineage change log retains at most 100 entries (`HISTORY_LIMIT`). Each
entry stores the parent graph and the set of content digests visible after the
change. Rollback is only valid to revisions within the retained window. When
entries are evicted, their digest sets no longer protect artifacts from garbage
collection. Releases themselves are never deleted by rollback or GC; only
orphaned source-map content is eligible for collection.

### Batch stability

`POST /v1/resolve/batch` captures one snapshot before processing any item and
acquires a read lease on that revision for the lifetime of the batch. All items
resolve against the same immutable view, regardless of concurrent lineage
changes. Identical requests within the batch are deduplicated so their
resolution work runs once, but every input index receives an independent deep
copy of the result, preserving order and per-item error isolation.

### Cancellation and resource release

The HTTP layer attaches an `AbortController` to each batch request, triggered by
client disconnect or `BATCH_TIMEOUT_MS` (default 30000). After abort: no new
jobs start, the bounded concurrency semaphore releases the in-flight slot in a
`finally` block, and the batch read lease is released so GC can proceed.
Unprocessed items return `error.code = "cancelled"` rather than being dropped.

### Safe garbage collection

Run `POST /v1/gc/preview` with the current revision to see what would be
collected. An artifact is collectible only when it is not referenced by: (1) any
currently registered release, (2) any retained history entry's digest set, or
(3) any active batch read lease. Execute with `POST /v1/gc` passing the
`expectedRevision` from the preview. If the revision changed between preview
and execute, the request is rejected with `412`; re-run preview. Because
releases are immutable and shared content is reference-protected, there is no
need to re-upload mappings after GC—collectible content is, by definition,
unreachable by any live or rollback-eligible path.
