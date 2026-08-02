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
subsequent requests immediately read the new revision. `GET /health` supports
process checks.

The project intentionally uses Node.js built-ins only. `BundleRegistry` owns
copy-on-write registry state, `RegistrySnapshot` owns detached read views,
`SymbolResolver` owns request projection and lineage walk, and
`ResolutionCache` only serves results for the registry revision that produced
them.
