/**
 * Discover project context files (AGENTS.md, CLAUDE.md) by walking up
 * the directory tree from cwd to root.
 *
 * This replicates the discovery logic from Pi's internal
 * `loadProjectContextFiles()` (resource-loader.ts) which is not exported
 * as a standalone function. We need it to inject user-provided project
 * guidelines into our custom system prompts.
 *
 * Per directory, the first match wins: AGENTS.md is checked before CLAUDE.md.
 * Files are returned in root → cwd order (ancestors first).
 */

import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

export interface ContextFile {
	path: string
	content: string
}

const CONTEXT_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"]

function loadContextFileFromDir(dir: string): ContextFile | null {
	for (const filename of CONTEXT_FILE_NAMES) {
		const filePath = join(dir, filename)
		if (existsSync(filePath)) {
			try {
				return { path: filePath, content: readFileSync(filePath, "utf-8") }
			} catch {
				// Unreadable file — skip silently
			}
		}
	}
	return null
}

/**
 * Walk from `cwd` up to the filesystem root, collecting one context file
 * per directory. Returns them in ancestor-first order (root → cwd).
 */
export function loadProjectContextFiles(cwd: string): ContextFile[] {
	const files: ContextFile[] = []

	let dir = resolve(cwd)
	const root = resolve("/")

	while (true) {
		const found = loadContextFileFromDir(dir)
		if (found) {
			files.unshift(found)
		}

		if (dir === root) break
		const parent = resolve(dir, "..")
		if (parent === dir) break
		dir = parent
	}

	return files
}
