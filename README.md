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

`POST /v1/lineage` atomically commits a batch of explicit parent-release
declarations scoped to one application and platform. The caller passes the
registry revision it read; a stale revision fails with 409, and any unknown
version, cross-boundary reference, duplicate relation, or cycle rejects the
whole batch. Lineage is never inferred from version strings and bundle
uploads never create it. During resolution an exact version match wins;
otherwise the nearest declared ancestor with a mapping supplies the source,
and each frame reports `exact`, `ancestor`, or `unmapped` plus the actual
`resolvedFrom` version and the registry revision read. `POST /v1/resolve/batch`
runs many resolve requests against one immutable snapshot captured at batch
start, returning results in input order with per-item errors located by index.

`POST /v1/lineage/preview` dry-runs the same batch against the same graph
validation: it reports every rejection reason with the offending change index,
flags a stale base revision, and — when valid — lists the releases whose
resolution source would change, all without mutating state.
`POST /v1/lineage/rollback` undoes a recorded batch as a brand-new validated
revision (never by resurrecting an old one), so inverse changes pass through
the identical unknown-version, cross-boundary, and cycle checks. Every
committed batch is kept in a bounded history (last 50) for rollback targeting.

Batch resolution runs under production execution controls: at most
`batchConcurrency` resolution units are in flight at once (default 4, with a
cooperative yield between units), and identical requests inside one batch are
resolved once against the batch's single immutable snapshot and then fanned
out in input order — duplicates still get their own located entries, and reuse
never crosses a registry revision. Cancelling the request, a client
disconnect, or the optional `BATCH_TIMEOUT_MS` deadline aborts the batch with
`batch_aborted` (408): no new resolution work starts afterwards and the
batch's read state is dropped immediately. A slow batch always finishes on
the snapshot it started with, even if lineage changes commit around it.

The project intentionally uses Node.js built-ins only. `BundleRegistry` owns
copy-on-write registry state, `RegistrySnapshot` owns detached read views,
`SymbolResolver` owns request projection, and `ResolutionCache` only serves
results for the registry revision that produced them.
