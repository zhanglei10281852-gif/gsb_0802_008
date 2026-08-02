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

The project intentionally uses Node.js built-ins only. `BundleRegistry` owns
copy-on-write registry state (bundles, artifacts, lineage, and bounded lineage
history), `lineage-engine.mjs` owns shared graph validation and impact
computation, `RegistrySnapshot` owns detached read views and ancestor
traversal, `SymbolResolver` owns request projection and batch fan-out,
`ResolutionCache` only serves results for the registry revision that produced
them, and `createServices` wires them together for the server and tests.
