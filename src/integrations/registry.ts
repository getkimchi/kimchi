// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import type { ToolDefinition, ToolId } from "./types.js"

/**
 * Central registry of tool integrations. TypeScript modules don't have
 * implicit init hooks, so the registry is populated by an explicit
 * `register()` call from each integration module's top level. Import
 * side-effects do the work.
 *
 * Loading the registry doesn't load the integration modules themselves —
 * call `loadAllIntegrations()` from your entry point (typically the setup
 * wizard or a `kimchi <tool>` command) to ensure all of them are imported.
 */
const tools = new Map<ToolId, ToolDefinition>()

export function register(tool: ToolDefinition): void {
	if (tools.has(tool.id)) {
		throw new Error(`Tool ${tool.id} already registered`)
	}
	tools.set(tool.id, tool)
}

export function all(): ToolDefinition[] {
	return Array.from(tools.values())
}

export function byId(id: ToolId): ToolDefinition | undefined {
	return tools.get(id)
}

/** Test-only: drop every registered tool. Use beforeEach in tests that mutate state. */
export function _resetRegistryForTests(): void {
	tools.clear()
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
