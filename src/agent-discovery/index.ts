import type { ServerEntry } from "../extensions/mcp-adapter/types.js"
import { claudeCode } from "./agents/claude-code.js"
import { openCode } from "./agents/opencode.js"
import { discoverAgent } from "./engine.js"

export interface AgentDefinition {
	/** Stable id, e.g. "claude-code", "opencode". */
	readonly id: string
	/** Human-readable name shown in the wizard, e.g. "Claude Code". */
	readonly displayName: string
	/**
	 * Config file paths tried in order. Every readable + parseable file
	 * contributes its servers to the merged result; deduplication happens
	 * at the MCP-server-name level (first-writer-wins), not at the file
	 * level. So if the same server name appears in two files, the entry
	 * from the earlier path in this list is kept. Files that don't exist
	 * are silently skipped; files that exist but fail to read or parse
	 * emit a warning and the loop continues to the next path. Empty
	 * array → no config to read.
	 */
	readonly configPaths: readonly string[]
	/**
	 * Skills directory candidates tried in order. The first existing
	 * directory wins. Empty array → no skills concept for this agent.
	 */
	readonly skillsDirs: readonly string[]
	/**
	 * Parse the raw config file contents. Defaults to JSON.parse if omitted.
	 * OpenCode uses a JSONC parser; CC uses plain JSON.
	 */
	readonly parseConfig?: (raw: string) => unknown
	/**
	 * Given the parsed config, return an ordered list of server-source
	 * blocks to ingest. Earlier entries win on name conflicts
	 * (first-writer-wins). For CC: project blocks first, then top-level.
	 * For OC: parsed.mcp first (modern), then parsed.mcpServers (legacy).
	 *
	 * A block can be either a bare `Record<string, unknown>` (used when no
	 * per-block context is needed, e.g. CC) or `{ entries, meta }` where
	 * `meta` is an opaque value passed to `transformServer` so a single
	 * definition can dispatch between schemas (e.g. OC modern vs legacy).
	 */
	readonly extractServerSources: (
		parsed: unknown,
	) => Array<Record<string, unknown> | { entries: Record<string, unknown>; meta?: unknown }>
	/**
	 * Convert one raw server entry to a ServerEntry. Return undefined to
	 * skip the entry (e.g. OC's `enabled: false`, malformed command arrays).
	 * The third argument is the `meta` from the source block this entry
	 * came from, or `undefined` when the block was returned as a bare map.
	 */
	readonly transformServer: (raw: unknown, name: string, meta?: unknown) => ServerEntry | undefined
}

export interface AgentDiscovery {
	readonly id: string
	readonly displayName: string
	readonly mcpServers: Record<string, ServerEntry>
	readonly skillCount: number
	readonly skillsDir?: string
}

export { discoverAgent }

export const AGENT_DEFINITIONS: readonly AgentDefinition[] = [claudeCode, openCode]
