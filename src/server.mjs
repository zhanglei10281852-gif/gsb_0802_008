import { BundleRegistry } from './bundle-registry.mjs'
import { createApiServer } from './http.mjs'
import { ResolutionCache } from './resolution-cache.mjs'
import { SymbolResolver } from './resolver.mjs'

const registry = new BundleRegistry()
const cache = new ResolutionCache()
const resolver = new SymbolResolver(registry, { cache })
const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '127.0.0.1'
const batchTimeoutMs = Number(process.env.BATCH_TIMEOUT_MS ?? 0)
const server = createApiServer({ registry, resolver, batchTimeoutMs })

server.listen(port, host, () => {
  console.log(`release-symbol-resolver-api listening on http://${host}:${port}`)
})
