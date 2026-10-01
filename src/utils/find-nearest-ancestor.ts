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
