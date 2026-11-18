/**
 * Discover context files (AGENTS.md, CLAUDE.md).
 *
 * Global files: Claude Code's user CLAUDE.md, then kimchi's own AGENTS.md
 * (see loadGlobalContextFiles). Project files: discovered by walking up
 * the directory tree from cwd to root.
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

function loadContextFileFromDir(dir: string): ContextFile | null {
	for (const filename of CONTEXT_FILE_NAMES) {
		const filePath = join(dir, filename)
		const localPath = join(dir, localVariant(filename))
		const primary = tryReadFile(filePath)
		const local = tryReadFile(localPath)

		if (primary !== null) {
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

export interface GlobalContextFileOptions {
	/** Read the Claude Code user file ($CLAUDE_CONFIG_DIR or ~/.claude)/CLAUDE.md. */
	includeClaudeCodeInstructions: boolean
}

/** Claude Code honors CLAUDE_CONFIG_DIR, so we must too, or we would read a file the user does not use. */
function claudeCodeConfigDir(): string {
	return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
}

function sameRealPath(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b)
	} catch {
		return false
	}
}

/**
 * Discover the global context files, in prompt order:
 *
 * 1. Claude Code's user instructions (`$CLAUDE_CONFIG_DIR/CLAUDE.md`, default
 *    `~/.claude/CLAUDE.md`), when `includeClaudeCodeInstructions` is set.
 *    Only CLAUDE.md is read there; Claude Code has no global `.local.md`.
 * 2. Kimchi's AGENTS.md in the agent configuration directory
 *    (~/.config/kimchi/harness/), with AGENTS.local.md appended if present.
 *
 * Kimchi's own file comes last because later files win on conflict, and it
 * is the more specific one for kimchi. The Claude Code file is dropped when
 * it is the same file as AGENTS.md (symlink) or holds the same text, so the
 * same rules never appear twice.
 */
export function loadGlobalContextFiles(options: GlobalContextFileOptions): ContextFile[] {
	const files: ContextFile[] = []
	const dir = getAgentDir()
	const agentsPath = dir ? join(dir, "AGENTS.md") : undefined
	const agentsPrimary = agentsPath ? tryReadFile(agentsPath) : null

	if (options.includeClaudeCodeInstructions) {
		const claudePath = join(claudeCodeConfigDir(), "CLAUDE.md")
		const claude = tryReadFile(claudePath)
		const duplicate =
			claude !== null &&
			agentsPath !== undefined &&
			agentsPrimary !== null &&
			(sameRealPath(claudePath, agentsPath) || claude.trim() === agentsPrimary.trim())
		if (claude !== null && !duplicate) files.push({ path: claudePath, content: claude })
	}

	if (!dir || !agentsPath) return files
	const localPath = join(dir, localVariant("AGENTS.md"))
	const local = tryReadFile(localPath)
	if (agentsPrimary !== null) {
		const content = local !== null ? `${agentsPrimary}\n\n${local}` : agentsPrimary
		files.push({ path: agentsPath, content })
	} else if (local !== null) {
		files.push({ path: localPath, content: local })
	}
	return files
}
