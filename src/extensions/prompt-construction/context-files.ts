/**
 * Discover context files (AGENTS.md, CLAUDE.md): global ones, then project
 * ones found by walking up from cwd to root.
 *
 * This replicates the discovery logic from Pi's internal
 * `loadProjectContextFiles()` (resource-loader.ts) which is not exported
 * as a standalone function. We need it to inject user-provided project
 * guidelines into our custom system prompts.
 *
 * Per directory, the first match wins: AGENTS.md is checked before CLAUDE.md.
 * When a primary file is found, its `.local.md` variant (e.g. CLAUDE.local.md)
 * is appended if present. A `.local.md` file without a primary file is also
 * loaded standalone. `.local.md` files are intended for user-specific,
 * gitignored overrides.
 *
 * Files are returned in root → cwd order (ancestors first).
 */

import { existsSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { getParsedCliArgs } from "../../cli-args.js"

export interface ContextFile {
	path: string
	content: string
}

const CONTEXT_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"]

function tryReadFile(filePath: string): string | null {
	if (!existsSync(filePath)) return null
	try {
		return readFileSync(filePath, "utf-8")
	} catch {
		return null
	}
}

/** Derive the `.local.md` variant for a context filename, e.g. "CLAUDE.md" → "CLAUDE.local.md". */
function localVariant(filename: string): string {
	return filename.replace(/\.md$/, ".local.md")
}

/** Same real path or same trimmed text. */
function isAlreadyLoaded(filePath: string, content: string, alreadyLoaded: readonly ContextFile[]): boolean {
	const trimmed = content.trim()
	return alreadyLoaded.some((file) => sameRealPath(file.path, filePath) || file.content.trim() === trimmed)
}

function loadContextFileFromDir(dir: string, alreadyLoaded: readonly ContextFile[]): ContextFile | null {
	for (const filename of CONTEXT_FILE_NAMES) {
		const filePath = join(dir, filename)
		const localPath = join(dir, localVariant(filename))
		const primary = tryReadFile(filePath)
		const local = tryReadFile(localPath)

		if (primary !== null) {
			// Check before the merge so .local.md survives. The duplicate still claims the dir.
			if (isAlreadyLoaded(filePath, primary, alreadyLoaded)) {
				return local !== null ? { path: localPath, content: local } : null
			}
			const content = local !== null ? `${primary}\n\n${local}` : primary
			return { path: filePath, content }
		}
		if (local !== null) {
			return { path: localPath, content: local }
		}
	}
	return null
}

/**
 * Walk from `cwd` up to the filesystem root, collecting one context file
 * per directory. Returns them in ancestor-first order (root → cwd).
 * Primary files that repeat one of `alreadyLoaded` are skipped.
 */
export function loadProjectContextFiles(cwd: string, alreadyLoaded: readonly ContextFile[] = []): ContextFile[] {
	// Review instructions arrive only through review-context/. Never inherit
	// project instructions from the neutral run directory or any ancestor when --review is enabled.
	if (getParsedCliArgs().options.review === true) return []
	const files: ContextFile[] = []

	let dir = resolve(cwd)
	const root = resolve("/")

	while (true) {
		const found = loadContextFileFromDir(dir, alreadyLoaded)
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

export interface GlobalContextFileOptions {
	includeClaudeCodeInstructions: boolean
}

/** Matches Claude Code, which honors CLAUDE_CONFIG_DIR. */
export function claudeCodeInstructionsPath(): string {
	return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "CLAUDE.md")
}

function sameRealPath(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b)
	} catch {
		return false
	}
}

/**
 * Global context files, in prompt order:
 * 1. `~/.claude/CLAUDE.md` (or `$CLAUDE_CONFIG_DIR`), if enabled. Skipped when it repeats AGENTS.md.
 * 2. Kimchi's AGENTS.md (+ AGENTS.local.md).
 */
export function loadGlobalContextFiles(options: GlobalContextFileOptions): ContextFile[] {
	return readGlobalContextFiles(options).files
}

/**
 * `sources` holds each global file before the .local.md merge. Project files
 * are compared against it, so a project copy of AGENTS.md still matches when
 * a global AGENTS.local.md exists.
 */
function readGlobalContextFiles(options: GlobalContextFileOptions): { files: ContextFile[]; sources: ContextFile[] } {
	const files: ContextFile[] = []
	const dir = getAgentDir()
	const agentsPath = dir ? join(dir, "AGENTS.md") : undefined
	const agentsPrimary = agentsPath ? tryReadFile(agentsPath) : null

	if (options.includeClaudeCodeInstructions) {
		const claudePath = claudeCodeInstructionsPath()
		const claude = tryReadFile(claudePath)
		const duplicate =
			claude !== null &&
			agentsPath !== undefined &&
			agentsPrimary !== null &&
			(sameRealPath(claudePath, agentsPath) || claude.trim() === agentsPrimary.trim())
		if (claude !== null && !duplicate) files.push({ path: claudePath, content: claude })
	}

	const sources = [...files]
	if (!dir || !agentsPath) return { files, sources }
	const localPath = join(dir, localVariant("AGENTS.md"))
	const local = tryReadFile(localPath)
	if (agentsPrimary !== null) {
		const content = local !== null ? `${agentsPrimary}\n\n${local}` : agentsPrimary
		files.push({ path: agentsPath, content })
		sources.push({ path: agentsPath, content: agentsPrimary })
	} else if (local !== null) {
		files.push({ path: localPath, content: local })
		sources.push({ path: localPath, content: local })
	}
	return { files, sources }
}

/** Global files, then project files that do not repeat them. */
export function loadContextFiles(cwd: string, options: GlobalContextFileOptions): ContextFile[] {
	if (getParsedCliArgs().options.review === true) return []
	const { files, sources } = readGlobalContextFiles(options)
	return [...files, ...loadProjectContextFiles(cwd, sources)]
}
