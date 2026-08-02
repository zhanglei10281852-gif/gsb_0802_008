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

`POST /v1/bundles` accepts an application, platform, version, an optional
`parentVersion`, and a non-empty list of source mappings. Identical map content
is stored once while each release keeps its own immutable descriptor. A release
that already exists cannot be re-uploaded, so lineage cannot be bypassed by
re-submitting mappings. `POST /v1/lineage` atomically adjusts a batch of
parent relationships against an `expectedRevision` (compare-and-swap); any
unknown version, cross-boundary reference, duplicate relationship, or cycle
rejects the entire batch. `POST /v1/resolve` accepts the same release identity
and one or more generated frames, resolving exact matches first and then walking
the declared lineage to the nearest ancestor. `POST /v1/resolve/batch` resolves
many requests against one immutable snapshot, returning per-item results in
input order and isolating failures to their index. `GET /health` supports
process checks.

The project intentionally uses Node.js built-ins only. `BundleRegistry` owns
copy-on-write registry state, `RegistrySnapshot` owns detached read views,
`SymbolResolver` owns request projection and lineage walk, and
`ResolutionCache` only serves results for the registry revision that produced
them.
