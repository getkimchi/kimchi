import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
}

let cacheDir: string | null = null
const entries = new Map<number, ImageRegistryEntry>()

/**
 * Set the directory where cached images live. Called from
 * clipboard-image.ts on session_start with `<sessionDir>/image-cache`.
 * Falls back to a tmpdir if sessionDir is unavailable.
 */
export function setImageCacheDir(dir: string | null): void {
	if (dir === null) {
		cacheDir = join(tmpdir(), `kimchi-image-cache-${randomUUID()}`)
	} else {
		cacheDir = dir
	}
	mkdirSync(cacheDir, { recursive: true })
}

/**
 * Get the active cache directory. Returns null before
 * setImageCacheDir has been called.
 */
export function getImageCacheDir(): string | null {
	return cacheDir
}

/**
 * Write an image to disk and register it under the given ID.
 * Returns the registry entry. Idempotent: registering the same
 * ID twice overwrites the previous entry but does NOT re-write
 * the file if sha1 matches.
 */
export function addImage(id: number, image: ImageContent): ImageRegistryEntry {
	if (!cacheDir) throw new Error("Image registry not initialised — call setImageCacheDir first")
	const bytes = Buffer.from(image.data, "base64")
	const sha1 = createHash("sha1").update(bytes).digest("hex")
	const ext = EXT_MAP[image.mimeType] ?? DEFAULT_EXT
	const path = join(cacheDir, `${id}${ext}`)
	if (!existsSync(path)) {
		writeFileSync(path, bytes)
	}
	const entry: ImageRegistryEntry = { id, path, mimeType: image.mimeType, sha1 }
	entries.set(id, entry)
	return entry
}

/**
 * Return all registered entries, ordered by id ascending.
 */
export function getAllImages(): ImageRegistryEntry[] {
	return [...entries.values()].sort((a, b) => a.id - b.id)
}

/**
 * Return entries for the given IDs, in the same order as `ids`.
 * Unknown IDs are silently skipped.
 */
export function getImagesByIds(ids: readonly number[]): ImageRegistryEntry[] {
	const out: ImageRegistryEntry[] = []
	for (const id of ids) {
		const entry = entries.get(id)
		if (entry) out.push(entry)
	}
	return out
}

/**
 * Clear the registry AND delete the cache directory + files.
 * Called on session_start.
 */
export function clearAllImages(): void {
	entries.clear()
	if (cacheDir && existsSync(cacheDir)) {
		try {
			rmSync(cacheDir, { recursive: true, force: true })
		} catch {
			// ignore — best-effort cleanup
		}
	}
	// Recreate the directory so subsequent adds work.
	if (cacheDir) mkdirSync(cacheDir, { recursive: true })
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
