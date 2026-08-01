# Release symbol resolver API

This small backend service stores release-specific symbol bundles and resolves
stack frames for crash processing systems. A caller uploads a bundle for one
application, platform, and release version, then asks the resolver to map
generated frame positions back to source locations. The current contract only
performs exact release matching.

```powershell
npm ci
npm test
npm run smoke
npm start
```

`POST /v1/bundles` accepts an application, platform, version, and a non-empty
list of source mappings. `POST /v1/resolve` accepts the same release identity
and one or more generated frames. `GET /health` supports process checks.

The project intentionally uses Node.js built-ins only. Its bundle registry
creates immutable read snapshots so HTTP callers never receive mutable store
objects. It does not yet support release lineage, cross-version fallback, or
batch resolution.
