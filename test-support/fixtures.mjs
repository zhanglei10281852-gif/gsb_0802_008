export function bundle (overrides = {}) {
  return {
    application: 'mobile-shell',
    platform: 'android',
    version: '2026.08.1',
    mappings: [
      {
        generated: { file: 'app.js', line: 10, column: 2 },
        source: { file: 'src/bootstrap.ts', line: 42, column: 4 }
      },
      {
        generated: { file: 'checkout.js', line: 19, column: 0 },
        source: { file: 'src/checkout.ts', line: 88, column: 8 }
      }
    ],
    ...overrides
  }
}

export function childBundle (overrides = {}) {
  return bundle({
    version: '2026.08.2',
    mappings: [
      {
        generated: { file: 'checkout.js', line: 19, column: 0 },
        source: { file: 'src/checkout-v2.ts', line: 90, column: 2 }
      }
    ],
    ...overrides
  })
}

export function lineageChange (overrides = {}) {
  return {
    application: 'mobile-shell',
    platform: 'android',
    version: '2026.08.2',
    parent: { application: 'mobile-shell', platform: 'android', version: '2026.08.1' },
    ...overrides
  }
}

export function resolveRequest (overrides = {}) {
  return {
    application: 'mobile-shell',
    platform: 'android',
    version: '2026.08.1',
    frames: [{ file: 'app.js', line: 10, column: 2 }],
    ...overrides
  }
}

export async function listen (server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${server.address().port}`
}
