import { isAbsolute, relative, resolve } from "node:path"

/** Return only paths outside every explicitly owned directory. Paths remain
 * repository-relative and otherwise unchanged, including unusual Git filenames. */
export function excludeReviewOwnedPaths<T extends string>(
	root: string,
	paths: readonly T[],
	excludedDirectories: readonly string[] = [],
): T[] {
	if (excludedDirectories.length === 0) return [...paths]
	return paths.filter((path) => {
		const candidate = resolve(root, path)
		return !excludedDirectories.some((directory) => {
			const remainder = relative(resolve(directory), candidate)
			return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder))
		})
	})
}
