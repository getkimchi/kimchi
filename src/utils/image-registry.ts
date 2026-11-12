import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import type { ImageContent } from "@earendil-works/pi-ai"

const EXT_MAP: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
	"image/gif": ".gif",
	"image/avif": ".avif",
}
const DEFAULT_EXT = ".bin"

export interface ImageRegistryEntry {
	/** 1-based session-local ID matching [Image #N] markers. */
	id: number
	/** Absolute path to cached file on disk. */
	path: string
	/** IANA mime type. */
	mimeType: string
	/** sha1 hex of the raw bytes — used for de-dup and forensics. */
	sha1: string
	/** Session that owns this entry — ids are only unique within a session. */
	sessionId: string
}

/**
 * Marker ids are per-session counters, so the registry must be too: the ACP
 * server hosts several sessions in one process via shared extension
 * factories, and a global map would let session B's start wipe session A's
 * entries and let B's fresh `[Image #1]` hijack A's marker.
 */
interface SessionScope {
	cacheDir: string | null
	entries: Map<number, ImageRegistryEntry>
}
const scopes = new Map<string, SessionScope>()

/**
 * Durable record of a session's registry, written next to the cached images
 * on every addImage. It is what lets a RESUMED session keep its transcript's
 * `[Image #N]` markers resolvable after the in-memory scope was lost (the
 * scope is reaped on session_shutdown, and the whole map dies with the
 * process). Without it, resume had to wipe the registry to stay consistent —
 * dead-ending every marker in the resumed transcript.
 */
const MANIFEST_FILE = "manifest.json"

interface ManifestEntry {
	file: string
	mimeType: string
	sha1: string
}

function writeManifest(scope: SessionScope): void {
	if (!scope.cacheDir) return
	const manifest: Record<string, ManifestEntry> = {}
	for (const entry of scope.entries.values()) {
		manifest[String(entry.id)] = { file: basename(entry.path), mimeType: entry.mimeType, sha1: entry.sha1 }
	}
	// Atomic via tmp+rename: a torn manifest would make restoreSessionImages
	// under-report the max id, and the next attachment's skip-if-exists write
	// would then bind new metadata to the previous image's bytes.
	const tmpPath = join(scope.cacheDir, `${MANIFEST_FILE}.tmp`)
	writeFileSync(tmpPath, JSON.stringify(manifest))
	renameSync(tmpPath, join(scope.cacheDir, MANIFEST_FILE))
}

function readManifest(cacheDir: string): Record<string, ManifestEntry> {
	try {
		return JSON.parse(readFileSync(join(cacheDir, MANIFEST_FILE), "utf8")) as Record<string, ManifestEntry>
	} catch {
		return {}
	}
}

function scopeFor(sessionId: string): SessionScope {
	let scope = scopes.get(sessionId)
	if (!scope) {
		scope = { cacheDir: null, entries: new Map() }
		scopes.set(sessionId, scope)
	}
	return scope
}

/**
 * Set the directory where a session's cached images live. Called from
 * clipboard-image.ts on session_start with `<sessionDir>/image-cache`.
 * Falls back to a tmpdir if sessionDir is unavailable.
 */
export function setImageCacheDir(sessionId: string, dir: string | null): void {
	const cacheDir = dir ?? join(tmpdir(), `kimchi-image-cache-${randomUUID()}`)
	mkdirSync(cacheDir, { recursive: true })
	scopeFor(sessionId).cacheDir = cacheDir
}

/**
 * Get a session's active cache directory. Returns null before
 * setImageCacheDir has been called for that session.
 */
export function getImageCacheDir(sessionId: string): string | null {
	return scopes.get(sessionId)?.cacheDir ?? null
}

/**
 * Write an image to disk and register it under the given ID for the owning
 * session. Returns the registry entry. Idempotent: registering the same ID
 * twice overwrites the previous entry but does NOT re-write the file if
 * sha1 matches.
 */
export function addImage(sessionId: string, id: number, image: ImageContent): ImageRegistryEntry {
	const scope = scopeFor(sessionId)
	if (!scope.cacheDir) {
		throw new Error(`Image registry not initialised for session ${sessionId} — call setImageCacheDir first`)
	}
	const bytes = Buffer.from(image.data, "base64")
	const sha1 = createHash("sha1").update(bytes).digest("hex")
	const ext = EXT_MAP[image.mimeType] ?? DEFAULT_EXT
	const path = join(scope.cacheDir, `${id}${ext}`)
	if (!existsSync(path)) {
		writeFileSync(path, bytes)
	}
	const entry: ImageRegistryEntry = { id, path, mimeType: image.mimeType, sha1, sessionId }
	scope.entries.set(id, entry)
	writeManifest(scope)
	return entry
}

/** Why a marker id could not be resolved to image bytes. */
export type ImageResolveResult =
	| { kind: "ok"; image: ImageContent }
	| { kind: "unknown" }
	| { kind: "missing-file"; path: string }
	| { kind: "read-error"; path: string; error: unknown }

/**
 * Resolve a `[Image #N]` marker that references an earlier turn's attachment.
 * The result distinguishes an unknown id (likely user prose) from a
 * registered id whose cache file is gone or unreadable (a lost attachment)
 * so callers can log/notify appropriately instead of silently leaving the
 * marker in the submitted text with no image behind it.
 */
export function resolveImageContentById(sessionId: string, id: number): ImageResolveResult {
	const entry = scopes.get(sessionId)?.entries.get(id)
	if (!entry) return { kind: "unknown" }
	if (!existsSync(entry.path)) return { kind: "missing-file", path: entry.path }
	try {
		return {
			kind: "ok",
			image: { type: "image", data: readFileSync(entry.path).toString("base64"), mimeType: entry.mimeType },
		}
	} catch (error) {
		return { kind: "read-error", path: entry.path, error }
	}
}

/**
 * Return all registered entries for a session, ordered by id ascending.
 */
export function getAllImages(sessionId: string): ImageRegistryEntry[] {
	const scope = scopes.get(sessionId)
	if (!scope) return []
	return [...scope.entries.values()].sort((a, b) => a.id - b.id)
}

/**
 * Return entries for the given IDs of a session, in the same order as `ids`.
 * Unknown IDs are silently skipped.
 */
export function getImagesByIds(sessionId: string, ids: readonly number[]): ImageRegistryEntry[] {
	const scope = scopes.get(sessionId)
	if (!scope) return []
	const out: ImageRegistryEntry[] = []
	for (const id of ids) {
		const entry = scope.entries.get(id)
		if (entry) out.push(entry)
	}
	return out
}

/**
 * Clear ONE session's entries AND delete its cache directory + files.
 * Called on session_start — other sessions sharing the process keep their
 * registry intact.
 */
export function clearSessionImages(sessionId: string): void {
	const scope = scopeFor(sessionId)
	scope.entries.clear()
	if (scope.cacheDir && existsSync(scope.cacheDir)) {
		try {
			rmSync(scope.cacheDir, { recursive: true, force: true })
		} catch {
			// ignore — best-effort cleanup
		}
	}
	// Recreate the directory so subsequent adds work.
	if (scope.cacheDir) mkdirSync(scope.cacheDir, { recursive: true })
}

/**
 * Rebuild a session's entries from its on-disk manifest after the in-memory
 * scope was lost (reaped on session_shutdown or dropped with the process).
 * No-op when the scope already has entries or no manifest exists. Returns
 * the highest known id so the caller can continue numbering past the
 * transcript's markers — a drop on a resumed session must never restart at
 * #1 and collide with a live `[Image #N]`.
 */
export function restoreSessionImages(sessionId: string): number {
	const scope = scopes.get(sessionId)
	if (!scope?.cacheDir) return 0
	if (scope.entries.size > 0) return Math.max(...scope.entries.keys())
	const manifest = readManifest(scope.cacheDir)
	let max = 0
	for (const [idText, m] of Object.entries(manifest)) {
		const id = Number(idText)
		const path = join(scope.cacheDir, m.file)
		if (!existsSync(path)) continue
		scope.entries.set(id, { id, path, mimeType: m.mimeType, sha1: m.sha1, sessionId })
		if (id > max) max = id
	}
	return max
}

/**
 * Drop a session's in-memory scope. Cache files and the manifest stay on
 * disk — a later session_start restores them via restoreSessionImages.
 * Called on session_shutdown so a long-lived ACP server does not pin every
 * closed session's entries for the process lifetime.
 */
export function removeSessionScope(sessionId: string): void {
	scopes.delete(sessionId)
}

/** @internal — test hook dropping every session scope between unit tests. */
export function __resetImageRegistryForTest(): void {
	scopes.clear()
}

/**
 * Parse a prompt string for [Image #N] markers.
 * Returns the unique IDs in order of first appearance.
 *
 * Examples:
 *   "[Image #1] foo"            → [1]
 *   "[Image #2] and [Image #1]" → [2, 1]
 *   "no images here"            → []
 *   "[Image #1][Image #1]"      → [1]    (deduped)
 */
export function parseImageReferences(prompt: string): number[] {
	const seen = new Set<number>()
	const out: number[] = []
	for (const match of prompt.matchAll(/\[Image\s+#(\d+)\]/g)) {
		const captured = match[1]
		if (!captured) continue
		const id = Number.parseInt(captured, 10)
		if (!seen.has(id)) {
			seen.add(id)
			out.push(id)
		}
	}
	return out
}
