export class BatchLeaseManager {
  #leases = new Set()

  acquire (digests) {
    const lease = { digests: new Set(digests) }
    this.#leases.add(lease)
    let released = false
    return () => {
      if (released) return
      released = true
      this.#leases.delete(lease)
    }
  }

  get liveDigests () {
    const union = new Set()
    for (const lease of this.#leases) {
      for (const digest of lease.digests) union.add(digest)
    }
    return union
  }

  get activeCount () {
    return this.#leases.size
  }
}
