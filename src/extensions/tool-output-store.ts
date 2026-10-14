/**
 * Tool-output externalization store.
 *
 * Large tool results are written to a
 * per-process append-only artifacts file at write time, and RAM keeps only a
 * small handle (`{ file, offset, length }`). Reads go through a lazy range
 * read with a bounded, refcount-aware LRU cache, so the big string is never a
 * long-lived JSC string — it is materialized transiently on demand and
 * released.
 *
 * Durability contract: this store is a MIRROR. The session log (JSONL)
 * remains the source of truth and always contains the full content; resume
 * never depends on this mirror. If the mirror is missing or corrupt,
 * `read()` returns `undefined` and callers fall back to the log.
 *
 * Knobs (env, documented in docs/):
 *   - `KIMCHI_TOOL_OUTPUT_STORE=off` disables externalization (escape hatch)
 *   - `KIMCHI_TOOL_OUTPUT_EXTERNALIZE_BYTES` (default 65536) — content above
 *     this size is externalized
 *   - `KIMCHI_TOOL_OUTPUT_CACHE_BYTES` (default 16777216) — resident read
 *     cache budget
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseEnvInt } from "../shared/env-int.js"

/** A lazy reference into an artifacts file: the mirror location of one tool result. */
export interface ToolOutputHandle {
	file: string
	offset: number
	length: number
}

export const TOOL_OUTPUT_MARKER_PREFIX = "[kimchi-ext:tool]"
export const TOOL_OUTPUT_EXTERNALIZE_BYTES = 64 * 1024
export const TOOL_OUTPUT_CACHE_BYTES = 16 * 1024 * 1024

export function toolOutputStoreEnabled(): boolean {
	return process.env.KIMCHI_TOOL_OUTPUT_STORE !== "off"
}

export function toolOutputExternalizeBytes(): number {
	return parseEnvInt("KIMCHI_TOOL_OUTPUT_EXTERNALIZE_BYTES", TOOL_OUTPUT_EXTERNALIZE_BYTES)
}

export function toolOutputCacheBytes(): number {
	return parseEnvInt("KIMCHI_TOOL_OUTPUT_CACHE_BYTES", TOOL_OUTPUT_CACHE_BYTES)
}

/** Encode a handle as a marker that survives JSON serialization and session persistence. */
export function makeMarker(handle: ToolOutputHandle): string {
	return TOOL_OUTPUT_MARKER_PREFIX + JSON.stringify(handle)
}

/**
 * Decode a marker into a handle. Returns `undefined` for any text that is not
 * a well-formed marker (guard against malformed or spoofed content).
 */
export function parseMarker(text: string): ToolOutputHandle | undefined {
	if (!text.startsWith(TOOL_OUTPUT_MARKER_PREFIX)) return undefined
	try {
		const parsed = JSON.parse(text.slice(TOOL_OUTPUT_MARKER_PREFIX.length)) as unknown
		if (typeof parsed !== "object" || parsed === null) return undefined
		const h = parsed as Partial<ToolOutputHandle>
		if (typeof h.file !== "string" || typeof h.offset !== "number" || typeof h.length !== "number") {
			return undefined
		}
		if (!Number.isInteger(h.offset) || !Number.isInteger(h.length) || h.offset < 0 || h.length < 0) {
			return undefined
		}
		return { file: h.file, offset: h.offset, length: h.length }
	} catch {
		return undefined
	}
}

interface CacheEntry {
	text: string
	lastUsed: number
}

export interface ToolOutputStore {
	/** Append `text` to the artifacts file and return its mirror handle. */
	record(text: string): ToolOutputHandle
	/**
	 * Lazy range read of a handle's content through the bounded LRU
	 * cache. Returns `undefined` when the mirror is missing or out of range
	 * (caller falls back to the session log).
	 */
	read(handle: ToolOutputHandle): string | undefined
	stats(): { file: string; size: number; cacheEntries: number; cacheBytes: number }
}

/**
 * Global seam consumed by the pi patch (session-manager serializer): the one
 * file this process's store issues handles into. The patch's persistence
 * path only resolves `[kimchi-ext:tool]` markers pointing at this exact file,
 * so spoofed markers in tool output cannot exfiltrate arbitrary files into
 * the session log.
 */
declare global {
	var __kimchiToolOutputFile: string | undefined
}

export function createToolOutputStore(dir: string, cacheBytes = toolOutputCacheBytes()): ToolOutputStore {
	mkdirSync(dir, { recursive: true })
	const file = join(dir, `tool-outputs-${process.pid}.log`)
	// Publish the confinement anchor for the patch-side serializer (see above).
	globalThis.__kimchiToolOutputFile = file
	let size = existsSync(file) ? statSync(file).size : 0
	const cache = new Map<string, CacheEntry>()
	let cacheBytesUsed = 0

	const keyOf = (h: ToolOutputHandle): string => `${h.file}@${h.offset}:${h.length}`

	const evictUntilFits = (incomingBytes: number): void => {
		if (cacheBytes <= 0 || cacheBytesUsed + incomingBytes <= cacheBytes) return
		const victims = [...cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
		for (const [key, entry] of victims) {
			if (cacheBytesUsed + incomingBytes <= cacheBytes) break
			cache.delete(key)
			cacheBytesUsed -= Buffer.byteLength(entry.text, "utf8")
		}
	}

	return {
		record(text) {
			const offset = size
			const length = Buffer.byteLength(text, "utf8")
			appendFileSync(file, text, "utf8")
			size += length
			return { file, offset, length }
		},
		read(handle) {
			// Path confinement: only markers this store issued (pointing at its
			// own artifacts file) may be hydrated — a spoofed marker in tool output
			// must not read arbitrary files into the provider payload or TUI.
			if (handle.file !== file) return undefined
			const key = keyOf(handle)
			const hit = cache.get(key)
			if (hit) {
				hit.lastUsed = Date.now()
				return hit.text
			}
			let text: string
			try {
				if (!existsSync(handle.file)) return undefined
				if (handle.offset < 0 || handle.length < 0 || handle.offset + handle.length > statSync(handle.file).size) {
					return undefined
				}
				const buffer = Buffer.alloc(handle.length)
				const fd = openSync(handle.file, "r")
				let bytesRead: number
				try {
					bytesRead = readSync(fd, buffer, 0, handle.length, handle.offset)
				} finally {
					closeSync(fd)
				}
				text = buffer.subarray(0, bytesRead).toString("utf8")
			} catch (error) {
				console.error(`[tool-output-store] read failed for ${handle.file}@${handle.offset}:`, error)
				return undefined
			}
			if (cacheBytes > 0 && handle.length <= cacheBytes) {
				evictUntilFits(handle.length)
				if (cacheBytesUsed + handle.length <= cacheBytes) {
					cache.set(key, { text, lastUsed: Date.now() })
					cacheBytesUsed += handle.length
				}
			}
			return text
		},
		stats() {
			return { file, size, cacheEntries: cache.size, cacheBytes: cacheBytesUsed }
		},
	}
}

let singletonStore: ToolOutputStore | undefined

/**
 * Process-wide store singleton, shared by the externalizers (write path), the
 * request hydration (read path) and the UI display budget (read path). The
 * artifacts dir is keyed by pid so a fresh process never aliases another
 * process's mirror file.
 */
export function getToolOutputStore(): ToolOutputStore | undefined {
	if (!toolOutputStoreEnabled()) return undefined
	if (!singletonStore) {
		singletonStore = createToolOutputStore(join(tmpdir(), `kimchi-tool-outputs-${process.pid}`), toolOutputCacheBytes())
	}
	return singletonStore
}

/**
 * Resolve a marker back to its full text through the store. Returns
 * `undefined` when the text is not a marker or the mirror is unreadable.
 * Shared by the request-hydration path and the UI display budget.
 */
export function readMarkerText(text: string): string | undefined {
	const handle = parseMarker(text)
	if (!handle) return undefined
	const store = getToolOutputStore()
	if (!store) return undefined
	return store.read(handle)
}

/** Test-only: forget the singleton (and the published confinement anchor) so a fresh store is created. */
export function resetToolOutputStoreForTests(): void {
	singletonStore = undefined
	globalThis.__kimchiToolOutputFile = undefined
}

/** Test-only: install a specific store as the process singleton (read seam). */
export function setToolOutputStoreForTests(store: ToolOutputStore | undefined): void {
	singletonStore = store
	globalThis.__kimchiToolOutputFile = store?.stats().file
}
