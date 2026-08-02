import assert from 'node:assert/strict'
import test from 'node:test'
import { BundleRegistry } from '../src/bundle-registry.mjs'
import { ResolutionCache } from '../src/resolution-cache.mjs'
import { SymbolResolver } from '../src/resolver.mjs'
import { bundle, resolveRequest } from '../test-support/fixtures.mjs'

function lineageRegistry () {
  const registry = new BundleRegistry()
  registry.put(bundle({
    version: '2026.08.1',
    mappings: [
      { generated: { file: 'app.js', line: 10, column: 2 }, source: { file: 'src/bootstrap.ts', line: 42, column: 4 } },
      { generated: { file: 'app.js', line: 20, column: 0 }, source: { file: 'src/shared.ts', line: 1, column: 0 } }
    ]
  }))
  registry.put(bundle({
    version: '2026.08.2',
    parentVersion: '2026.08.1',
    mappings: [
      { generated: { file: 'app.js', line: 10, column: 2 }, source: { file: 'src/bootstrap.ts', line: 50, column: 4 } }
    ]
  }))
  registry.put(bundle({
    version: '2026.08.3',
    parentVersion: '2026.08.2',
    mappings: [
      { generated: { file: 'hotfix.js', line: 3, column: 0 }, source: { file: 'src/hotfix.ts', line: 9, column: 0 } }
    ]
  }))
  return registry
}

test('resolves an exact match before consulting ancestors', () => {
  const registry = lineageRegistry()
  const result = new SymbolResolver(registry).resolve(resolveRequest({
    version: '2026.08.2',
    frames: [{ file: 'app.js', line: 10, column: 2 }]
  }))
  assert.equal(result.registryRevision, 3)
  assert.equal(result.frames[0].status, 'exact')
  assert.equal(result.frames[0].resolvedFrom, '2026.08.2')
  assert.equal(result.frames[0].source.line, 50)
})

test('walks declared lineage to the nearest ancestor with a mapping', () => {
  const registry = lineageRegistry()
  const result = new SymbolResolver(registry).resolve(resolveRequest({
    version: '2026.08.3',
    frames: [
      { file: 'app.js', line: 10, column: 2 },
      { file: 'app.js', line: 20, column: 0 },
      { file: 'hotfix.js', line: 3, column: 0 },
      { file: 'missing.js', line: 1, column: 0 }
    ]
  }))
  assert.equal(result.frames[0].status, 'ancestor')
  assert.equal(result.frames[0].resolvedFrom, '2026.08.2')
  assert.equal(result.frames[0].source.line, 50)
  assert.equal(result.frames[1].status, 'ancestor')
  assert.equal(result.frames[1].resolvedFrom, '2026.08.1')
  assert.equal(result.frames[2].status, 'exact')
  assert.equal(result.frames[2].resolvedFrom, '2026.08.3')
  assert.equal(result.frames[3].status, 'unmapped')
  assert.equal(result.frames[3].resolvedFrom, null)
  assert.equal(result.frames[3].source, null)
})

test('picks the nearest ancestor rather than a deeper one', () => {
  const registry = new BundleRegistry()
  registry.put(bundle({
    version: '2026.08.1',
    mappings: [
      { generated: { file: 'app.js', line: 20, column: 0 }, source: { file: 'src/deep.ts', line: 1, column: 0 } }
    ]
  }))
  registry.put(bundle({
    version: '2026.08.2',
    parentVersion: '2026.08.1',
    mappings: [
      { generated: { file: 'app.js', line: 20, column: 0 }, source: { file: 'src/middle.ts', line: 2, column: 0 } }
    ]
  }))
  registry.put(bundle({
    version: '2026.08.2.1',
    parentVersion: '2026.08.2',
    mappings: [
      { generated: { file: 'hotfix.js', line: 1, column: 0 }, source: { file: 'src/hotfix.ts', line: 1, column: 0 } }
    ]
  }))
  const result = new SymbolResolver(registry).resolve(resolveRequest({
    version: '2026.08.2.1',
    frames: [{ file: 'app.js', line: 20, column: 0 }]
  }))
  assert.equal(result.frames[0].status, 'ancestor')
  assert.equal(result.frames[0].resolvedFrom, '2026.08.2')
  assert.equal(result.frames[0].source.file, 'src/middle.ts')
})

test('exposes parentVersion and registryRevision on every resolve result', () => {
  const registry = lineageRegistry()
  const result = new SymbolResolver(registry).resolve(resolveRequest({ version: '2026.08.3' }))
  assert.equal(result.parentVersion, '2026.08.2')
  assert.equal(result.registryRevision, 3)
})

test('ancestor resolution is revision-scoped through the cache', () => {
  const registry = lineageRegistry()
  const resolver = new SymbolResolver(registry, { cache: new ResolutionCache() })
  const before = resolver.resolve(resolveRequest({
    version: '2026.08.3',
    frames: [{ file: 'app.js', line: 10, column: 2 }]
  }))
  assert.equal(before.frames[0].resolvedFrom, '2026.08.2')

  registry.put(bundle({
    version: '2026.08.4',
    mappings: [
      { generated: { file: 'app.js', line: 10, column: 2 }, source: { file: 'src/latest.ts', line: 1, column: 0 } }
    ]
  }))
  registry.adjustLineage({
    expectedRevision: 4,
    relationships: [
      { application: 'mobile-shell', platform: 'android', version: '2026.08.3', parentVersion: '2026.08.4' }
    ]
  })

  const after = resolver.resolve(resolveRequest({
    version: '2026.08.3',
    frames: [{ file: 'app.js', line: 10, column: 2 }]
  }))
  assert.equal(after.registryRevision, 5)
  assert.equal(after.frames[0].status, 'ancestor')
  assert.equal(after.frames[0].resolvedFrom, '2026.08.4')
  assert.equal(after.frames[0].source.file, 'src/latest.ts')
})

test('does not cross application or platform boundaries during ancestor walk', () => {
  const registry = lineageRegistry()
  registry.put(bundle({
    application: 'mobile-shell',
    platform: 'ios',
    version: '2026.08.1',
    mappings: [bundle().mappings[0]]
  }))
  assert.throws(
    () => new SymbolResolver(registry).resolve(resolveRequest({
      platform: 'ios',
      version: '2026.08.3'
    })),
    (error) => error.code === 'bundle_not_found'
  )
})
