// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

/**
 * Walk from `cwd` up to the filesystem root looking for `relativePath`.
 * Returns the nearest existing `join(dir, relativePath)` (closest to cwd
 * wins), or undefined when nothing matches along the way.
 *
 * Shared implementation for ancestor lookups (skill discovery, hierarchical
 * config files) — keep this the single copy of the walk loop.
 */
export function findNearestAncestorPath(cwd: string, relativePath: string): string | undefined {
	let dir = resolve(cwd)
	while (true) {
		const candidate = join(dir, relativePath)
		if (existsSync(candidate)) return candidate
		const parent = dirname(dir)
		if (parent === dir) return undefined
		dir = parent
	}
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
