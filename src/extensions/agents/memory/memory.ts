/**
 * memory.ts — Persistent agent memory: per-agent memory directories that persist across sessions.
 *
 * Memory scopes:
 *   - "user"    → ~/.config/kimchi/harness/agent-memory/{agent-name}/
 *   - "project" → .kimchi/agent-memory/{agent-name}/
 *   - "local"   → .kimchi/agent-memory-local/{agent-name}/
 */

import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import type { MemoryScope } from "../personas/types.js"

/** Maximum lines to read from MEMORY.md */
const MAX_MEMORY_LINES = 200

/**
 * Returns true if a name contains characters not allowed in agent/skill names.
 * Uses a whitelist: only alphanumeric, hyphens, underscores, and dots (no leading dot).
 */
export function isUnsafeName(name: string): boolean {
	if (!name || name.length > 128) return true
	return !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)
}

/**
 * Returns true if the given path is a symlink (defense against symlink attacks).
 */
export function isSymlink(filePath: string): boolean {
	try {
		return lstatSync(filePath).isSymbolicLink()
	} catch {
		return false
	}
}

/**
 * Safely read a file, rejecting symlinks.
 * Returns undefined if the file doesn't exist, is a symlink, or can't be read.
 */
export function safeReadFile(filePath: string): string | undefined {
	if (!existsSync(filePath)) return undefined
	if (isSymlink(filePath)) return undefined
	try {
		return readFileSync(filePath, "utf-8")
	} catch {
		return undefined
	}
}

/**
 * Resolve the memory directory path for a given agent + scope + cwd.
 * Throws if agentName contains path traversal characters.
 *
 * Paths:
 *   - "user"    → ~/.config/kimchi/harness/agent-memory/<name>/
 *   - "project" → <cwd>/.kimchi/agent-memory/<name>/
 *   - "local"   → <cwd>/.kimchi/agent-memory-local/<name>/
 */
export function resolveMemoryDir(agentName: string, scope: MemoryScope, cwd: string): string {
	if (isUnsafeName(agentName)) {
		throw new Error(`Unsafe agent name for memory directory: "${agentName}"`)
	}
	switch (scope) {
		case "user":
			return join(getAgentDir(), "agent-memory", agentName)
		case "project":
			return join(cwd, ".kimchi", "agent-memory", agentName)
		case "local":
			return join(cwd, ".kimchi", "agent-memory-local", agentName)
	}
}

/**
 * Ensure the memory directory exists, creating it if needed.
 * Refuses to create directories if any component in the path is a symlink.
 */
export function ensureMemoryDir(memoryDir: string): void {
	if (existsSync(memoryDir)) {
		if (isSymlink(memoryDir)) {
			throw new Error(`Refusing to use symlinked memory directory: ${memoryDir}`)
		}
		return
	}
	mkdirSync(memoryDir, { recursive: true })
}

/**
 * Read the first N lines of MEMORY.md from the memory directory, if it exists.
 * Returns undefined if no MEMORY.md exists or if the path is a symlink.
 */
export function readMemoryIndex(memoryDir: string): string | undefined {
	if (isSymlink(memoryDir)) return undefined

	const memoryFile = join(memoryDir, "MEMORY.md")
	const content = safeReadFile(memoryFile)
	if (content === undefined) return undefined

	const lines = content.split("\n")
	if (lines.length > MAX_MEMORY_LINES) {
		return `${lines.slice(0, MAX_MEMORY_LINES).join("\n")}\n... (truncated at 200 lines)`
	}
	return content
}

/**
 * Build the memory block to inject into the agent's system prompt.
 * Also ensures the memory directory exists (creates it if needed).
 */
export function buildMemoryBlock(agentName: string, scope: MemoryScope, cwd: string): string {
	const memoryDir = resolveMemoryDir(agentName, scope, cwd)
	ensureMemoryDir(memoryDir)

	const existingMemory = readMemoryIndex(memoryDir)

	const header = `# Agent Memory

You have a persistent memory directory at: ${memoryDir}/
Memory scope: ${scope}

This memory persists across sessions. Use it to build up knowledge over time.`

	const memoryContent = existingMemory
		? `\n\n## Current MEMORY.md\n${existingMemory}`
		: `\n\nNo MEMORY.md exists yet. Create one at ${join(memoryDir, "MEMORY.md")} to start building persistent memory.`

	const instructions = `

## Memory Instructions
- MEMORY.md is an index file — keep it concise (under 200 lines). Lines after 200 are truncated.
- Store detailed memories in separate files within ${memoryDir}/ and link to them from MEMORY.md.
- Each memory file should use this frontmatter format:
  \`\`\`markdown
  ---
  name: <memory name>
  description: <one-line description>
  type: <user|feedback|project|reference>
  ---
  <memory content>
  \`\`\`
- Update or remove memories that become outdated. Check for existing memories before creating duplicates.
- You have Read, Write, and Edit tools available for managing memory files.`

	return header + memoryContent + instructions
}

/**
 * Build a read-only memory block for agents that lack write/edit tools.
 * Does NOT create the memory directory — agents can only consume existing memory.
 */
export function buildReadOnlyMemoryBlock(agentName: string, scope: MemoryScope, cwd: string): string {
	const memoryDir = resolveMemoryDir(agentName, scope, cwd)
	const existingMemory = readMemoryIndex(memoryDir)

	const header = `# Agent Memory (read-only)

Memory scope: ${scope}
You have read-only access to memory. You can reference existing memories but cannot create or modify them.`

	const memoryContent = existingMemory
		? `\n\n## Current MEMORY.md\n${existingMemory}`
		: "\n\nNo memory is available yet. Other agents or sessions with write access can create memories for you to consume."

	return header + memoryContent
}
