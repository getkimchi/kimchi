import type { ServerEntry } from "../extensions/mcp-adapter/types.js"
import { claudeCode } from "./agents/claude-code.js"
import { cursor } from "./agents/cursor.js"
import { openCode } from "./agents/opencode.js"
import { SKILLS_ONLY_AGENTS } from "./agents/skills-only.js"
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
	 *
	 * Invariant: entries must be home-level absolute paths — discovery has
	 * no cwd parameter for configs, so a relative entry would silently
	 * resolve against the ambient process working directory (and is dropped
	 * with a warning under "home" scope). Use a `{ projectRelative }`
	 * candidate on skillsDirs/commandsDirs for cwd-dependent locations.
	 */
	readonly configPaths: readonly string[]
	/**
	 * Skills directory candidates tried in order. The first existing
	 * directory wins. Empty array → no skills concept for this agent.
	 */
	readonly skillsDirs: readonly DirCandidate[]
	/**
	 * Commands directory candidates tried in order. The first existing
	 * directory wins. Commands are .md files that can be migrated as
	 * prompts. Empty array → no commands concept for this agent.
	 */
	readonly commandsDirs: readonly DirCandidate[]
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

/**
 * A directory a source app may keep skills or commands in.
 *
 * - A plain string is a home-level absolute path. `homedir()` is stable for
 *   the process lifetime, so freezing it at module load is safe.
 * - A `{ projectRelative }` candidate is resolved against a working directory
 *   per discovery call (`discoverAgent`'s `cwd` option, defaulting to
 *   `process.cwd()` read at call time). Resolving per call matters for
 *   long-lived processes: a harness spawned by a desktop app inherits the
 *   app's working directory, and freezing it at module load bakes in a value
 *   that is meaningless (and possibly permission-prompting) later.
 */
export type DirCandidate = string | { readonly projectRelative: string }

/** One skill found under a source app's skills directory. */
export interface DiscoveredSkill {
	/** Invocation name (frontmatter `name`, falling back to the skill directory name). */
	readonly name: string
	/** Human-readable description from the skill's frontmatter. */
	readonly description: string
	/** Absolute path to the skill's SKILL.md. */
	readonly path: string
}

export interface AgentDiscovery {
	readonly id: string
	readonly displayName: string
	readonly mcpServers: Record<string, ServerEntry>
	/**
	 * Number of subdirectories in the winning skills directory, or -1 when the
	 * directory exists but could not be read (e.g. EACCES) — distinct from 0
	 * ("empty") so consumers can tell "nothing here" from "couldn't read what
	 * is here".
	 */
	readonly skillCount: number
	/**
	 * Enumerated skills from the winning skills directory. Added alongside
	 * `skillCount` (which still counts every subdirectory, valid or not) so
	 * the terminal wizard and the telemetry snapshot behave identically.
	 * A skill whose SKILL.md cannot be read or parsed is omitted.
	 */
	readonly skills: readonly DiscoveredSkill[]
	readonly skillsDir?: string
	readonly commandsCount: number
	readonly commandsDir?: string
}

export { discoverAgent }

export const AGENT_DEFINITIONS: readonly AgentDefinition[] = [claudeCode, openCode, cursor, ...SKILLS_ONLY_AGENTS]
