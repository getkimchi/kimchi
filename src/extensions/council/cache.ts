import { createHash } from "node:crypto"

export interface CouncilCacheKey {
	patchHash: string
	baseSnapshotHash: string
	objectiveHash: string
	constraintsHash: string
	evidenceHash: string
	role: string
	modelId: string
	promptVersion: string
	schemaVersion: string
}

export interface CouncilCacheStats {
	hits: number
	misses: number
	entries: number
	bytes: number
}

type CacheKind = "packet" | "result"

interface CacheEntry {
	value: unknown
	bytes: number
}

const DEFAULT_MAX_ENTRIES = 24
const DEFAULT_MAX_BYTES = 1024 * 1024
const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024

export function hashCouncilCacheValue(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function cacheId(kind: CacheKind, key: CouncilCacheKey): string {
	return JSON.stringify([
		kind,
		key.patchHash,
		key.baseSnapshotHash,
		key.objectiveHash,
		key.constraintsHash,
		key.evidenceHash,
		key.role,
		key.modelId,
		key.promptVersion,
		key.schemaVersion,
	])
}

export class CouncilSessionCache {
	private readonly entries = new Map<string, CacheEntry>()
	private hits = 0
	private misses = 0
	private bytes = 0

	constructor(
		private readonly maxEntries = DEFAULT_MAX_ENTRIES,
		private readonly maxBytes = DEFAULT_MAX_BYTES,
		private readonly maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
	) {}

	getPacket<T>(key: CouncilCacheKey): T | undefined {
		return this.get("packet", key)
	}

	getResult<T>(key: CouncilCacheKey): T | undefined {
		return this.get("result", key)
	}

	setPacket(key: CouncilCacheKey, value: unknown): boolean {
		return this.set("packet", key, value)
	}

	setResult<T>(key: CouncilCacheKey, value: T, validate: (value: unknown) => boolean): boolean {
		if (!validate(value)) return false
		return this.set("result", key, value)
	}

	private get<T>(kind: CacheKind, key: CouncilCacheKey): T | undefined {
		const id = cacheId(kind, key)
		const entry = this.entries.get(id)
		if (!entry) {
			this.misses++
			return undefined
		}
		this.hits++
		this.entries.delete(id)
		this.entries.set(id, entry)
		return structuredClone(entry.value) as T
	}

	private set(kind: CacheKind, key: CouncilCacheKey, value: unknown): boolean {
		const serialized = JSON.stringify(value)
		const bytes = Buffer.byteLength(serialized)
		if (bytes > this.maxEntryBytes || bytes > this.maxBytes) return false
		const id = cacheId(kind, key)
		const previous = this.entries.get(id)
		if (previous) {
			this.bytes -= previous.bytes
			this.entries.delete(id)
		}
		while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
			const oldest = this.entries.keys().next().value
			if (typeof oldest !== "string") break
			const evicted = this.entries.get(oldest)
			if (evicted) this.bytes -= evicted.bytes
			this.entries.delete(oldest)
		}
		this.entries.set(id, { value: JSON.parse(serialized), bytes })
		this.bytes += bytes
		return true
	}

	snapshot(): CouncilCacheStats {
		return { hits: this.hits, misses: this.misses, entries: this.entries.size, bytes: this.bytes }
	}
}

export function cacheStatsDelta(before: CouncilCacheStats, after: CouncilCacheStats): CouncilCacheStats {
	return {
		hits: Math.max(0, after.hits - before.hits),
		misses: Math.max(0, after.misses - before.misses),
		entries: after.entries,
		bytes: after.bytes,
	}
}
