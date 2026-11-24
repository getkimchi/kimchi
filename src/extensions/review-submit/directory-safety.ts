import type { Stats } from "node:fs"
import { lstat, mkdir, realpath, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"

export type DirectoryCheck =
	| { kind: "ready"; path: string }
	| { kind: "unavailable" }
	| { kind: "unsafe"; reason: string }

export interface DirectoryOptions {
	/** Trust only this project directory; all components below it must be real. */
	projectDir?: string
	/** Whether this directory is the project-local default rather than a flag value. */
	isDefault: boolean
	/** Output paths may create missing directories. Context reads never create them. */
	create: boolean
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code
}

function missing(error: unknown): boolean {
	return errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR"
}

async function existingMetadata(path: string): Promise<Stats | undefined> {
	try {
		return await lstat(path)
	} catch (error) {
		if (missing(error)) return undefined
		throw error
	}
}

async function createCheckedDirectories(base: string, components: string[], create: boolean): Promise<DirectoryCheck> {
	let current = base
	for (const component of components) {
		current = join(current, component)
		try {
			let metadata = await existingMetadata(current)
			if (!metadata) {
				if (!create) return { kind: "unavailable" }
				try {
					await mkdir(current, { mode: 0o700 })
				} catch (error) {
					// Another process may have created the component; lstat decides
					// whether it is a real directory or a swapped symlink/non-directory.
					if (!missing(error) && errorCode(error) !== "EEXIST") throw error
				}
				// Always re-read after mkdir/EEXIST to catch a swapped component.
				metadata = await existingMetadata(current)
			}
			if (!metadata) return { kind: "unavailable" }
			if (metadata.isSymbolicLink()) return { kind: "unsafe", reason: `${current} is a symlink` }
			if (!metadata.isDirectory()) return { kind: "unsafe", reason: `${current} is not a directory` }
		} catch (error) {
			if (missing(error)) return { kind: "unavailable" }
			throw error
		}
	}
	return { kind: "ready", path: current }
}

/** Resolve a default path or a caller-selected path without ever creating a
 * directory through a symlink. Flag ancestors may be symlinks; their realpath
 * is only the base above which the caller selected the new subtree. */
export async function checkReviewDirectory(path: string, options: DirectoryOptions): Promise<DirectoryCheck> {
	try {
		const requested = resolve(path)
		if (options.isDefault) {
			if (!options.projectDir) return { kind: "unsafe", reason: "the project directory is unavailable" }
			const project = resolve(options.projectDir)
			const remainder = relative(project, requested)
			if (remainder === "" || remainder.startsWith("..") || isAbsolute(remainder)) {
				return { kind: "unsafe", reason: "the path is not contained by the project directory" }
			}
			const metadata = await existingMetadata(project)
			if (!metadata) return { kind: "unavailable" }
			if (!metadata.isDirectory()) return { kind: "unsafe", reason: "the project path is not a directory" }
			const checked = await createCheckedDirectories(project, remainder.split(/[\\/]+/), options.create)
			if (checked.kind !== "ready") return checked
			return { kind: "ready", path: await realpath(checked.path) }
		}

		const components: string[] = []
		let existing = requested
		while (true) {
			const metadata = await existingMetadata(existing)
			if (metadata) {
				// The selected leaf itself may never be a symlink, but an existing
				// ancestor may be one (for example /tmp on macOS).
				if (existing === requested && metadata.isSymbolicLink()) {
					return { kind: "unsafe", reason: `${requested} is a symlink` }
				}
				if (!metadata.isDirectory() && !metadata.isSymbolicLink()) {
					return { kind: "unsafe", reason: `${existing} is not a directory` }
				}
				const realBase = await realpath(existing)
				if ((await stat(realBase)).isDirectory() === false) {
					return { kind: "unsafe", reason: `${existing} is not a directory` }
				}
				const checked = await createCheckedDirectories(realBase, components, options.create)
				if (checked.kind !== "ready") return checked
				return { kind: "ready", path: await realpath(checked.path) }
			}
			const parent = dirname(existing)
			if (parent === existing) return { kind: "unavailable" }
			components.unshift(basename(existing))
			existing = parent
		}
	} catch {
		return { kind: "unsafe", reason: "the directory could not be created or resolved safely" }
	}
}
