// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
/**
 * Session-scoped in-memory cache for web_fetch results.
 *
 * Keyed by URL + format composite key. Entries expire after a configurable TTL
 * (default 15 minutes). The cache is cleared on session shutdown.
 */

/** Default TTL in milliseconds (15 minutes). */
const DEFAULT_TTL_MS = 15 * 60 * 1000

/** Default maximum number of cache entries before eviction kicks in. */
export const MAX_ENTRIES = 100

export interface CacheEntry {
	/** The fully rendered tool output (metadata header + content body). */
	output: string
	/** Timestamp when the entry was stored (Date.now()). */
	storedAt: number
}

export interface CacheOptions {
	ttlMs?: number
	maxEntries?: number
}

export class Cache {
	private readonly store = new Map<string, CacheEntry>()
	private readonly ttlMs: number
	private readonly maxEntries: number

	constructor(options?: CacheOptions) {
		this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS
		this.maxEntries = options?.maxEntries ?? MAX_ENTRIES
	}

	/** Build a composite cache key from URL and format. */
	static key(url: string, format: string): string {
		return `${url}::${format}`
	}

	/**
	 * Look up a cached result. Returns the output string on hit, or `undefined`
	 * on miss or expiry. Expired entries are evicted on access.
	 */
	get(url: string, format: string): string | undefined {
		const key = Cache.key(url, format)
		const entry = this.store.get(key)
		if (!entry) return undefined

		if (Date.now() - entry.storedAt > this.ttlMs) {
			this.store.delete(key)
			return undefined
		}

		return entry.output
	}

	/** Store a result in the cache. Evicts the oldest entry when at capacity. */
	set(url: string, format: string, output: string): void {
		const key = Cache.key(url, format)

		// Evict oldest entry if at capacity (skip if we're overwriting an existing key)
		if (this.store.size >= this.maxEntries && !this.store.has(key)) {
			let oldestKey: string | undefined
			let oldestTime = Number.POSITIVE_INFINITY
			for (const [k, v] of this.store) {
				if (v.storedAt < oldestTime) {
					oldestTime = v.storedAt
					oldestKey = k
				}
			}
			if (oldestKey) this.store.delete(oldestKey)
		}

		this.store.set(key, { output, storedAt: Date.now() })
	}

	/** Clear all cached entries. Called on session shutdown. */
	clear(): void {
		this.store.clear()
	}

	/** Number of entries currently in the cache. */
	get size(): number {
		return this.store.size
	}
}

// ---------------------------------------------------------------------------
// Default singleton — keeps the same module-level API for consumers.
// ---------------------------------------------------------------------------

const defaultCache = new Cache()

/** Build a composite cache key from URL and format. */
export function cacheKey(url: string, format: string): string {
	return Cache.key(url, format)
}

export function cacheGet(url: string, format: string): string | undefined {
	return defaultCache.get(url, format)
}

export function cacheSet(url: string, format: string, output: string): void {
	defaultCache.set(url, format, output)
}

export function cacheClear(): void {
	defaultCache.clear()
}

export function cacheSize(): number {
	return defaultCache.size
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
