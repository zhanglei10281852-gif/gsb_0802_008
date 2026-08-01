import { ApiError } from './errors.mjs'

const platforms = new Set(['android', 'ios', 'web'])

export function readIdentity (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'invalid_payload', 'Request body must be an object')
  }
  if (typeof value.application !== 'string' || value.application.trim().length === 0) {
    throw new ApiError(400, 'invalid_application', 'application is required')
  }
  if (typeof value.platform !== 'string' || !platforms.has(value.platform)) {
    throw new ApiError(400, 'invalid_platform', 'platform must be android, ios, or web')
  }
  if (typeof value.version !== 'string' || value.version.trim().length === 0) {
    throw new ApiError(400, 'invalid_version', 'version is required')
  }
  return {
    application: value.application.trim(),
    platform: value.platform,
    version: value.version.trim()
  }
}

export function bundleKey (identity) {
  return `${identity.application}\u0000${identity.platform}\u0000${identity.version}`
}

export function readMappings (value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiError(400, 'invalid_mappings', 'mappings must be a non-empty array')
  }
  const keys = new Set()
  return value.map((mapping) => {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
      throw new ApiError(400, 'invalid_mapping', 'every mapping must be an object')
    }
    const generated = mapping.generated
    const source = mapping.source
    if (!generated || typeof generated.file !== 'string' || !Number.isInteger(generated.line) || generated.line < 1 || !Number.isInteger(generated.column) || generated.column < 0) {
      throw new ApiError(400, 'invalid_generated_position', 'generated position is invalid')
    }
    if (!source || typeof source.file !== 'string' || !Number.isInteger(source.line) || source.line < 1 || !Number.isInteger(source.column) || source.column < 0) {
      throw new ApiError(400, 'invalid_source_position', 'source position is invalid')
    }
    const key = positionKey(generated)
    if (keys.has(key)) throw new ApiError(400, 'duplicate_mapping', 'generated positions must be unique')
    keys.add(key)
    return {
      generated: { file: generated.file, line: generated.line, column: generated.column },
      source: { file: source.file, line: source.line, column: source.column }
    }
  })
}

export function readFrames (value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new ApiError(400, 'invalid_frames', 'frames must contain between 1 and 100 items')
  }
  return value.map((frame) => {
    if (!frame || typeof frame !== 'object' || typeof frame.file !== 'string' || !Number.isInteger(frame.line) || frame.line < 1 || !Number.isInteger(frame.column) || frame.column < 0) {
      throw new ApiError(400, 'invalid_frame', 'frame file, line, and column are required')
    }
    return { file: frame.file, line: frame.line, column: frame.column }
  })
}

export function positionKey (position) {
  return `${position.file}\u0000${position.line}\u0000${position.column}`
}
