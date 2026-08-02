const copy = (value) => structuredClone(value)

export class ResolutionCache {
  #entries = new Map()

  constructor ({ limit = 256 } = {}) {
    this.limit = limit
  }

  read (snapshotRevision, requestKey) {
    const key = `${snapshotRevision}\u0000${requestKey}`
    const value = this.#entries.get(key)
    if (!value) return null
    this.#entries.delete(key)
    this.#entries.set(key, value)
    return copy(value)
  }

  write (snapshotRevision, requestKey, result) {
    const key = `${snapshotRevision}\u0000${requestKey}`
    this.#entries.delete(key)
    this.#entries.set(key, copy(result))
    while (this.#entries.size > this.limit) this.#entries.delete(this.#entries.keys().next().value)
  }

  stats () {
    return { size: this.#entries.size, limit: this.limit }
  }
}
