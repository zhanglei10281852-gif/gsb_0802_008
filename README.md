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

The project intentionally uses Node.js built-ins only. `BundleRegistry` owns
copy-on-write registry state, `RegistrySnapshot` owns detached read views,
`SymbolResolver` owns request projection, and `ResolutionCache` only serves
results for the registry revision that produced them.
