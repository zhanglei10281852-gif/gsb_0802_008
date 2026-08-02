import { BatchLeaseManager } from './batch-lease-manager.mjs'
import { BundleRegistry } from './bundle-registry.mjs'
import { createApiServer } from './http.mjs'
import { ResolutionCache } from './resolution-cache.mjs'
import { SymbolResolver } from './resolver.mjs'

const leaseManager = new BatchLeaseManager()
const registry = new BundleRegistry({ leaseManager })
const cache = new ResolutionCache()
const resolver = new SymbolResolver(registry, { cache, leaseManager })
const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '127.0.0.1'
const server = createApiServer({ registry, resolver })

server.listen(port, host, () => {
  console.log(`release-symbol-resolver-api listening on http://${host}:${port}`)
})
