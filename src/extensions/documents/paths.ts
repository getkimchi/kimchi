/**
 * Shared path-identity helpers for the document CLIs. `sameFile` backs the
 * "never write in place" guarantees: a plain `resolve()` compare misses
 * case-insensitive collisions (default macOS APFS, Windows) and symlinks,
 * either of which would let an edit clobber its own input.
 */

import { realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const CASE_INSENSITIVE_PLATFORM = process.platform === "darwin" || process.platform === "win32"

/** Realpath with the not-on-disk-yet fallback of resolving the deepest
 *  existing ancestor (an --out path may not exist yet). */
function realPathOf(p: string): string {
	const abs = resolve(p)
	try {
		return realpathSync(abs)
	} catch {
		const dir = dirname(abs)
		if (dir === abs) return abs
		try {
			return join(realpathSync(dir), basenameOf(abs))
		} catch {
			return abs
		}
	}
}

function basenameOf(p: string): string {
	const parts = p.split(/[\\/]/)
	return parts[parts.length - 1] ?? p
}

/** True when both spellings refer to the same file on disk. */
export function sameFile(a: string, b: string): boolean {
	const ra = realPathOf(a)
	const rb = realPathOf(b)
	if (ra === rb) return true
	if (CASE_INSENSITIVE_PLATFORM) return ra.toLowerCase() === rb.toLowerCase()
	return false
}
