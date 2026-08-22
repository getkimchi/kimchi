/**
 * memory.ts — Persistent agent memory: per-agent memory directories that persist across sessions.
 *
 * Memory scopes:
 *   - "user"    → ~/.config/kimchi/harness/agent-memory/{agent-name}/
 *   - "project" → .kimchi/agent-memory/{agent-name}/
 *   - "local"   → .kimchi/agent-memory-local/{agent-name}/
 */

import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { pathToFileURL } from "node:url"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import type { MemoryScope } from "../personas/types.js"

// ── Pluggable memory provider registry ─────────────────────────────────────

/**
 * Generic agent memory provider. External extensions cannot hook subagent
 * system-prompt construction, so the harness exposes this registry: any
 * memory backend connects by exporting a default-conforming provider from a
 * module listed in `<agent-dir>/memory-providers.json` (or by calling
 * registerMemoryProvider from in-tree code). resolveMemoryBlock tries each
 * provider in order until one returns a block. When every provider returns
 * null (disabled, unreachable, not applicable), file-based memory is used —
 * full backwards compatibility.
 *
 * The harness keeps ZERO provider-specific code; this file is the entire
 * integration surface.
 */
/** Resolution context passed to providers so they can honour scope and tool access. */
export interface AgentMemoryContext {
	/** Memory scope the agent was configured with (user/project/local). */
	scope: MemoryScope
	/** Whether the agent has write tools (read-only agents cannot maintain memory). */
	hasWriteTools: boolean
}

export interface AgentMemoryProvider {
	/** Stable display name (e.g. "openviking"). */
	name: string
	/**
	 * Build the memory prompt block for the agent, or resolve null when the
	 * provider is disabled/unreachable/not applicable (fallback continues).
	 * The optional context lets providers tailor output to the memory scope
	 * and respect read-only agents; plain two-argument implementations
	 * stay compatible.
	 */
	buildBlock(agentName: string, cwd: string, context?: AgentMemoryContext): Promise<string | null>
}

const memoryProviders: AgentMemoryProvider[] = []

/** Register an agent memory provider. Later registrations are tried last. */
export function registerMemoryProvider(provider: AgentMemoryProvider): void {
	memoryProviders.push(provider)
}

/** Registered providers in resolution order (primarily for tests). */
export function getMemoryProviders(): readonly AgentMemoryProvider[] {
	return memoryProviders
}

/** Remove all registered providers (primarily for tests). */
export function clearMemoryProviders(): void {
	memoryProviders.length = 0
}

// ── Config-driven provider loading ─────────────────────────────────────────

/** Path of the provider manifest: `[{name, module: "/abs/path/module.ts|mjs"}]`. */
export function resolveMemoryProvidersConfig(): string {
	return join(getAgentDir(), "memory-providers.json")
}

let providersLoadPromise: Promise<void> | null = null

/**
 * Lazily import provider modules listed in memory-providers.json, once.
 * Fail-open per module: invalid entries, unreadable config, and import
 * failures are skipped so memory resolution never breaks.
 */
async function loadConfiguredProviders(): Promise<void> {
	if (providersLoadPromise) return providersLoadPromise

	providersLoadPromise = (async () => {
		try {
			const configPath = resolveMemoryProvidersConfig()
			if (!existsSync(configPath)) return
			if (isSymlink(configPath)) return

			let list: unknown
			try {
				const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"))
				list = Array.isArray(parsed) ? parsed : (parsed as { providers?: unknown })?.providers
			} catch {
				return
			}
			if (!Array.isArray(list)) return

			for (const entry of list as Array<{ module?: unknown }>) {
				const modulePath = entry?.module
				if (typeof modulePath !== "string" || modulePath.length === 0) continue
				// Validate before importing: only absolute, existing, non-symlink
				// paths are usable, and the import goes through a file:// URL so
				// platform paths (spaces, Windows drive letters) resolve correctly.
				// Anything that can write the manifest can already run code here
				// (any extension file could), so confinement is the manifest
				// owner's responsibility — documented in the README.
				if (!isAbsolute(modulePath)) continue
				if (!existsSync(modulePath)) continue
				if (isSymlink(modulePath)) continue
				try {
					const mod: unknown = await import(pathToFileURL(modulePath).href)
					const provider = (mod as { default?: unknown })?.default ?? mod
					if (
						provider &&
						typeof provider === "object" &&
						typeof (provider as AgentMemoryProvider).name === "string" &&
						typeof (provider as AgentMemoryProvider).buildBlock === "function"
					) {
						memoryProviders.push(provider as AgentMemoryProvider)
					}
				} catch {
					// Skip unloadable provider modules.
				}
			}
		} catch {
			// Defensive: config or filesystem failures must never wedge the
			// load promise (a rejected promise would re-throw forever). Reset
			// so the next resolveMemoryBlock retries from scratch.
			providersLoadPromise = null
		}
	})()

	return providersLoadPromise
}

/** Reset lazy config load state (primarily for tests). */
export function resetProviderLoadState(): void {
	providersLoadPromise = null
}

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
 * Resolve the memory block through the registered providers.
 *
 * Each provider is tried in registration order; the first non-null block
 * wins. Provider failures are contained (fail-open) — a broken provider logs
 * nothing and never breaks memory resolution. When every provider returns
 * null, falls back to the file-based memory block (buildMemoryBlock or
 * buildReadOnlyMemoryBlock depending on tool access).
 */
export async function resolveMemoryBlock(
	agentName: string,
	scope: MemoryScope,
	cwd: string,
	hasWriteTools: boolean,
): Promise<string> {
	await loadConfiguredProviders()
	for (const provider of memoryProviders) {
		try {
			const block = await provider.buildBlock(agentName, cwd, { scope, hasWriteTools })
			// Accept only non-empty strings: a provider returning undefined
			// must not leak into the Promise<string> contract.
			if (typeof block === "string" && block.length > 0) return block
		} catch {
			// Fail-open: a broken provider must not break memory resolution.
		}
	}
	return hasWriteTools ? buildMemoryBlock(agentName, scope, cwd) : buildReadOnlyMemoryBlock(agentName, scope, cwd)
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
