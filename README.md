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

The project intentionally uses Node.js built-ins only. `BundleRegistry` owns
copy-on-write registry state (bundles, artifacts, and lineage),
`RegistrySnapshot` owns detached read views and ancestor traversal,
`SymbolResolver` owns request projection and batch fan-out, `ResolutionCache`
only serves results for the registry revision that produced them, and
`createServices` wires them together for the server and tests.
