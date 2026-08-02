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

`POST /v1/gc/preview` and `POST /v1/gc` close the content lifecycle. A
release can be collected only when it is not an ancestor in the current
lineage, not referenced by the retained rollback history window, and not read
by an active batch lease; artifacts are freed only when no remaining release
references them (content orphaned by a replaced upload is always safe). The
preview lists every blocking reason per release plus the artifacts that would
be freed; the real collection re-validates against the previewed revision and
the live leases, and fails with 409 if anything changed — deletion has no
undo, so nothing is removed on a stale view.

## Maintenance notes

- **Revision switching.** Every mutation (bundle upload, lineage apply or
  rollback, garbage collection) commits a brand-new copy-on-write state with
  a monotonically increasing revision. Writers pass the revision they based
  their decision on; a mismatch answers 409 and changes nothing. Readers only
  ever see fully committed states.
- **History retention.** The last 50 lineage commits are kept for rollback
  targeting. Older entries are forgotten, rollback only works inside the
  window, and rollback is itself a new commit — old revisions are never
  resurrected. Garbage collection is not rollbackable by design.
- **Batch stability.** A batch captures one immutable snapshot when it
  starts; deduplicated reads are scoped to that snapshot and revision;
  concurrent lineage commits or collections land on new revisions and never
  leak into a running batch, which finishes on the view it started with.
- **Cancellation.** Client disconnect or the batch timeout aborts the batch:
  workers stop before starting new resolution units, the pending queue and
  deduplicated results are dropped, the batch's read leases are released, and
  no response is written to the dead connection.
- **Safe collection.** Always preview first and collect on the same revision.
  Collection is refused while any current lineage chain, retained history
  entry, or active batch lease references the target; the checks run again at
  commit time, so a release can never be deleted out from under a reader.

The project intentionally uses Node.js built-ins only. `BundleRegistry` owns
copy-on-write registry state, `RegistrySnapshot` owns detached read views,
`SymbolResolver` owns request projection, and `ResolutionCache` only serves
results for the registry revision that produced them.
