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

export function readOptionalParentVersion (value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError(400, 'invalid_parent_version', 'parentVersion must be a non-empty string when provided')
  }
  return value.trim()
}

export function readExpectedRevision (value) {
  if (value === undefined || value === null) return null
  if (!Number.isInteger(value) || value < 0) {
    throw new ApiError(400, 'invalid_expected_revision', 'expectedRevision must be a non-negative integer')
  }
  return value
}

export function readLineageChanges (value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    throw new ApiError(400, 'invalid_lineage_changes', 'changes must contain between 1 and 500 items')
  }
  const seen = new Set()
  return value.map((change, index) => {
    if (!change || typeof change !== 'object' || Array.isArray(change)) {
      throw new ApiError(400, 'invalid_lineage_change', `change at index ${index} must be an object`)
    }
    const identity = readIdentity(change)
    const parentVersion = readOptionalParentVersion(change.parentVersion)
    const key = bundleKey(identity)
    if (seen.has(key)) {
      throw new ApiError(400, 'duplicate_lineage_change', `release ${identity.application}/${identity.platform}/${identity.version} appears more than once in the batch`)
    }
    seen.add(key)
    return { identity, parentVersion }
  })
}

export function readBatchItems (value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new ApiError(400, 'invalid_batch_items', 'items must contain between 1 and 100 entries')
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { index, error: { code: 'invalid_item', message: `item at index ${index} must be an object` } }
    }
    try {
      const identity = readIdentity(item)
      const frames = readFrames(item.frames)
      return { index, identity, frames }
    } catch (error) {
      if (error instanceof ApiError) {
        return { index, error: { code: error.code, message: error.message } }
      }
      throw error
    }
  })
}
