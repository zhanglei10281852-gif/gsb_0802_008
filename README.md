# Release symbol resolver API

This backend service stores content-addressed symbol bundles for mobile and web
releases, then resolves generated stack frames to source locations for crash
processing systems. It keeps a revisioned in-memory registry, produces
detached read snapshots, and uses a bounded cache scoped to the snapshot that
created each result. The current public contract deliberately resolves only the
exact application, platform, and release version supplied by the caller.

```powershell
npm ci
npm test
npm run smoke
npm start
```

`POST /v1/bundles` accepts an application, platform, version, and a non-empty
list of source mappings. Identical map content is stored once while each
release keeps its own immutable descriptor. `POST /v1/resolve` accepts the
same release identity and one or more generated frames. `GET /health` supports
process checks.

`POST /v1/lineage` accepts an application, platform, an `expectedRevision`, and
a non-empty list of `{ version, parent }` relations. The whole batch is applied
atomically against the captured revision: if any relation names an unknown
version, crosses the application/platform boundary, duplicates a child, repeats
an existing edge, or would introduce a cycle, nothing changes and the registry
revision is untouched. A stale `expectedRevision` returns `409 revision_conflict`.
Lineage is declared explicitly — it is never inferred from version strings, and
declaring it never re-uploads or mutates bundle content.

`POST /v1/lineage/preview` runs the exact same graph validation and impact math
as apply but changes nothing. It returns `ok`, a structured `rejection` reason
when the change would be refused, and an `impact` list of the releases whose
declared ancestry (and therefore resolution source) would move, each with its
`previousAncestry` and `nextAncestry`.

`POST /v1/lineage/rollback` accepts an application, platform, `expectedRevision`,
and a `toRevision`. It restores that scope's lineage to the historical
checkpoint as a brand-new validated revision — it never resurrects the old
revision number, never revives a release that no longer exists, and only touches
edges inside the requested application/platform boundary. A bounded history of
recent lineage checkpoints is retained; rolling back to a revision older than the
retained window is refused rather than guessed.

Preview, apply, and rollback share one graph-validation and impact engine
(`lineage-engine.mjs`); the HTTP routes stay thin and never re-implement the
rules. Every lineage mutation forms a new immutable revision: requests that
started after a switch see only the new revision, while a request that already
captured an older snapshot completes entirely within that view.

Resolution stays exact-first: a frame resolves against the requested release
when that position exists, otherwise it walks the declared lineage nearest
ancestor first. Every frame reports `status` (`exact`, `ancestor`, or
`unmapped`), the concrete `resolvedFrom` version, and the response echoes the
`registryRevision` that was read.

`POST /v1/resolve/batch` accepts `{ items: [...] }` where each item is an
ordinary resolve request. The whole batch shares one immutable snapshot
captured at the start, returns results in input order, and isolates a bad item
(invalid input or missing bundle) to its own entry via `ok: false` and `index`
without discarding the other results.

Under production load the batch runs with bounded execution control that does
not change any result semantics: a worker pool caps how many resolutions run at
once, and identical items inside the same batch reuse a single resolution read
(scoped to that snapshot's revision, so reuse never mixes old and new lineage).
Duplicates still each receive their own detached, locatable result. The route
runs the batch under an `AbortController` wired to the request timeout and the
client connection — on cancellation, timeout, or disconnect the pool stops
starting new work and releases the batch's read-reuse table promptly, and a
batch that could not finish reports `499 request_cancelled`. Requests that begin
after a lineage switch still observe the newer revision.

`POST /v1/reclaim/preview` accepts an application, platform, and a `versions`
list, and reports which of those releases can be safely reclaimed and which are
`blocked`, together with the `basedOnRevision` it observed and how many artifacts
would be `freed`. `POST /v1/reclaim` performs the deletion; it requires the
`expectedRevision` the preview returned and refuses with `409 revision_conflict`
if the registry has moved on, or `409 reclaim_blocked` if any requested version
is still referenced. A release is reclaimable only when nothing references its
bundle key: not the live lineage graph, not the retained rollback-history window,
and not an active batch read lease. Content is content-addressed and shared, so
an artifact is freed only once no surviving release still references its digest —
reclaiming one release never orphans a map another release shares. Preview,
reclaim, apply, and rollback all share the one engine in `lineage-engine.mjs`.

The project intentionally uses Node.js built-ins only. `BundleRegistry` owns
copy-on-write registry state (bundles, artifacts, lineage, and bounded lineage
history) plus transient batch read leases, `lineage-engine.mjs` owns shared graph
validation, impact, and reclamation-safety computation, `RegistrySnapshot` owns
detached read views and ancestor traversal, `SymbolResolver` owns request
projection and batch fan-out, `ResolutionCache` only serves results for the
registry revision that produced them, and `createServices` wires them together
for the server and tests.

## Maintenance notes

**How the revision switches.** Every state-changing operation — `put`,
`applyLineage`, `rollbackLineage`, and `reclaimBundles` — replaces `#state` with
a new object at `revision + 1` via copy-on-write; readers never mutate shared
maps. `applyLineage`, `rollbackLineage`, and `reclaimBundles` require the
caller's `expectedRevision` to equal the current revision and return
`409 revision_conflict` otherwise, so a decision made against a preview can only
be committed against the exact state it previewed. The exact-resolution contract
(`/v1/bundles`, `/v1/resolve`, its status codes and field shapes) is unchanged;
lineage, batch, and reclaim are additive.

**History retention boundary.** Lineage checkpoints are retained in a bounded
ring of `HISTORY_LIMIT` (64) entries; the oldest is evicted once the limit is
exceeded. Rollback to a revision still inside the window restores that
checkpoint; rollback to an evicted revision is refused with
`422 revision_unavailable` rather than guessed. Because the retained window keeps
a release reachable, reclamation treats any version named by a history checkpoint
as `referenced_by_history` and refuses to delete it until it ages out.

**Why a batch is stable.** A batch captures exactly one snapshot at the start and
resolves every item against it, so concurrent lineage switches or reclamations
never change what an in-flight batch sees; its response echoes that single
`registryRevision`. Duplicate items within the batch share one memoized read
keyed by request content, but each returns an independently detached copy.

**How cancellation releases resources.** At snapshot capture the batch also
acquires a registry read lease pinning the bundle keys live at that revision.
When the batch finishes — or is cancelled, times out, or the client disconnects —
its `finally` clears the memo and releases the lease, so nothing keeps the
content pinned once no batch is reading it. Cancelled batches report
`499 request_cancelled`.

**When content is safe to reclaim.** Preview first with `/v1/reclaim/preview` to
see the reclaimable set, blocked reasons, and `basedOnRevision`; then commit with
`/v1/reclaim` carrying that revision. Content is deletable only when it is
referenced by none of: the current lineage, the retained history window, or an
active batch lease. Do not rely on re-uploading to undo a mistaken reclaim of
still-referenced content — that path is blocked by design; preview is the safety
gate.
