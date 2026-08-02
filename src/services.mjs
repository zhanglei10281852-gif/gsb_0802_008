import { BundleRegistry } from './bundle-registry.mjs'
import { ResolutionCache } from './resolution-cache.mjs'
import { SymbolResolver } from './resolver.mjs'

// Builds the registry, cache, and resolver as one wired unit so the server and
// tests share an identical composition of the service layer.
export function createServices ({ cacheLimit = 256 } = {}) {
  const registry = new BundleRegistry()
  const cache = new ResolutionCache({ limit: cacheLimit })
  const resolver = new SymbolResolver(registry, { cache })
  return { registry, cache, resolver }
}
