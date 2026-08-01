export class ApiError extends Error {
  constructor (statusCode, code, message) {
    super(message)
    this.name = 'ApiError'
    this.statusCode = statusCode
    this.code = code
  }
}

export function toApiError (error) {
  if (error instanceof ApiError) return error
  return new ApiError(500, 'internal_error', 'Unexpected resolver failure')
}
