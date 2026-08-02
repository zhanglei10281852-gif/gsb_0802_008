import { ApiError, toApiError } from './errors.mjs'
import { bundleKey, positionKey, readBatchBody, readFrames, readIdentity } from './validation.mjs'

const copy = (value) => structuredClone(value)

function createAbortError () {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

class Semaphore {
  constructor (limit) {
    this.limit = Math.max(1, limit)
    this.active = 0
    this.waiters = []
  }

  acquire (signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError())
        return
      }
      const grant = () => {
        this.active++
        let released = false
        resolve(() => {
          if (released) return
          released = true
          this.active--
          this.#drain()
        })
      }
      if (this.active < this.limit) {
        grant()
        return
      }
      const entry = { grant, reject, signal }
      entry.onAbort = () => {
        const i = this.waiters.indexOf(entry)
        if (i !== -1) this.waiters.splice(i, 1)
        entry.signal.removeEventListener('abort', entry.onAbort)
        reject(createAbortError())
      }
      if (signal) signal.addEventListener('abort', entry.onAbort, { once: true })
      this.waiters.push(entry)
    })
  }

  #drain () {
    while (this.active < this.limit && this.waiters.length > 0) {
      const entry = this.waiters.shift()
      if (entry.signal) entry.signal.removeEventListener('abort', entry.onAbort)
      if (entry.signal?.aborted) {
        entry.reject(createAbortError())
        continue
      }
      entry.grant()
    }
  }
}

export class SymbolResolver {
  constructor (registry, { cache = null, concurrency = 8, batchWork = null } = {}) {
    this.registry = registry
    this.cache = cache
    this.concurrency = Math.max(1, concurrency)
    this.batchWork = batchWork
    this.#semaphore = new Semaphore(this.concurrency)
  }

  #semaphore

  resolve (body) {
    const identity = readIdentity(body)
    const frames = readFrames(body.frames)
    const snapshot = this.registry.snapshot()
    const requestKey = JSON.stringify({ identity, frames })
    const cached = this.cache?.read(snapshot.revision, requestKey)
    if (cached) return cached
    const result = this.resolveSnapshot({ identity, frames, snapshot })
    this.cache?.write(snapshot.revision, requestKey, result)
    return result
  }

  async resolveBatch (body, { signal } = {}) {
    const requests = readBatchBody(body)
    const snapshot = this.registry.snapshot()

    const finalResults = new Array(requests.length)
    const jobs = []
    const dedup = new Map()

    for (let i = 0; i < requests.length; i++) {
      const item = requests[i]
      try {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new ApiError(400, 'invalid_request', 'each batch item must be an object')
        }
        const identity = readIdentity(item)
        const frames = readFrames(item.frames)
        const key = JSON.stringify({ a: identity.application, p: identity.platform, v: identity.version, f: frames })
        let job = dedup.get(key)
        if (!job) {
          job = { identity, frames, indices: [] }
          dedup.set(key, job)
          jobs.push(job)
        }
        job.indices.push(i)
      } catch (error) {
        const known = toApiError(error)
        finalResults[i] = { index: i, ok: false, error: { code: known.code, message: known.message } }
      }
    }

    const jobOutcomes = await this.#runJobs(jobs, snapshot, signal)

    for (let j = 0; j < jobs.length; j++) {
      for (const out of jobOutcomes[j]) {
        finalResults[out.index] = out
      }
    }

    return { registryRevision: snapshot.revision, results: finalResults }
  }

  async #runJobs (jobs, snapshot, signal) {
    const outcomes = new Array(jobs.length)
    let cursor = 0
    const workerCount = Math.min(this.concurrency, jobs.length)
    const workers = []

    for (let w = 0; w < workerCount; w++) {
      workers.push((async () => {
        while (true) {
          if (signal?.aborted) return
          const i = cursor++
          if (i >= jobs.length) return
          outcomes[i] = await this.#runJob(jobs[i], snapshot, signal)
        }
      })())
    }

    await Promise.all(workers)

    for (let i = 0; i < jobs.length; i++) {
      if (!outcomes[i]) {
        outcomes[i] = jobs[i].indices.map((index) => ({
          index,
          ok: false,
          error: { code: 'cancelled', message: 'batch was cancelled before this item was processed' }
        }))
      }
    }
    return outcomes
  }

  async #runJob (job, snapshot, signal) {
    const cancelled = () => job.indices.map((index) => ({
      index,
      ok: false,
      error: { code: 'cancelled', message: 'batch was cancelled before this item was processed' }
    }))

    let release
    try {
      release = await this.#semaphore.acquire(signal)
    } catch {
      return cancelled()
    }

    try {
      if (signal) await new Promise((resolve) => setImmediate(resolve))
      if (signal?.aborted) return cancelled()

      if (this.batchWork) {
        await this.batchWork({ identity: job.identity, frames: job.frames, snapshot, signal })
        if (signal?.aborted) return cancelled()
      }

      const result = this.resolveSnapshot({ identity: job.identity, frames: job.frames, snapshot })
      return job.indices.map((index) => ({ index, ok: true, ...copy(result) }))
    } catch (error) {
      if (signal?.aborted) return cancelled()
      const known = toApiError(error)
      return job.indices.map((index) => ({
        index,
        ok: false,
        error: { code: known.code, message: known.message }
      }))
    } finally {
      release()
    }
  }

  resolveSnapshot ({ identity, frames, snapshot }) {
    const chain = snapshot.walkLineage(identity)
    if (chain.length === 0) throw new ApiError(404, 'bundle_not_found', 'No bundle exists for this release')
    const exactBundle = snapshot.getBundle(chain[0])
    if (!exactBundle) throw new ApiError(404, 'bundle_not_found', 'No bundle exists for this release')

    const frameResults = frames.map((frame) => this.#resolveFrame({ frame, chain, snapshot }))

    return {
      application: identity.application,
      platform: identity.platform,
      version: identity.version,
      parentVersion: exactBundle.parentVersion,
      registryRevision: snapshot.revision,
      frames: frameResults
    }
  }

  #resolveFrame ({ frame, chain, snapshot }) {
    const targetKey = positionKey(frame)
    const visitedBundles = new Set()
    for (const ancestorIdentity of chain) {
      const aKey = bundleKey(ancestorIdentity)
      if (visitedBundles.has(aKey)) break
      visitedBundles.add(aKey)
      const bundle = snapshot.getBundle(ancestorIdentity)
      if (!bundle) continue
      const source = bundle.mappingIndex.get(targetKey)
      if (source) {
        const isExact = ancestorIdentity.version === chain[0].version
        return {
          generated: copy(frame),
          status: isExact ? 'exact' : 'ancestor',
          source: copy(source),
          resolvedFrom: ancestorIdentity.version
        }
      }
    }
    return { generated: copy(frame), status: 'unmapped', source: null, resolvedFrom: null }
  }
}
