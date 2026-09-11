import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { RequestError } from "@agentclientprotocol/sdk"
import {
	AGENT_DEFINITIONS,
	type AgentDefinition,
	type DiscoveredSkill,
	discoverAgent,
} from "../../../agent-discovery/index.js"
import {
	ALWAYS_SHOWN_SKILL_PATHS,
	KIMCHI_CONFIG_PATH,
	writeJsonObjectFile,
	writeMigrationState,
	writeSkillPaths,
} from "../../../config.js"
import type { ServerEntry } from "../../../extensions/mcp-adapter/types.js"
import { toSkillName } from "../../../setup-wizard.js"

/**
 * import_apply over ACP — the write half of the onboarding import
 * (ADR-0043/ADR-0044). A client sends the user's selection as item
 * identities — exactly what import_discover reported — and those items are
 * actually imported: skills are *copied* into Kimchi's own skills directory
 * with their tree intact, selected MCP servers are merged into Kimchi's MCP
 * config, and the migration marker is set so the terminal wizard does not
 * re-ask. Source apps are never registered as scan paths, and nothing the
 * user already has is overwritten.
 *
 * The handler re-discovers home-scope instead of trusting client-supplied
 * file contents: there is no trust boundary to defend (the client spawns the
 * harness and already has unrestricted filesystem access), but binding the
 * applied items back to what is on disk at apply time keeps the two calls
 * consistent when the disk changed between the user seeing the screen and
 * pressing the button.
 *
 * Source: castai/kimchi/kimchi-studio#372 (blocked-by sibling #370).
 */

/** One selected skill, addressed as import_discover reported it. */
export interface ImportApplySkillSelection {
	/** Stable id of the source app the skill was discovered under. */
	sourceAppId: string
	/** Absolute path to the skill's SKILL.md, as returned by discovery. */
	path: string
}

/** One selected MCP server, addressed as import_discover reported it. */
export interface ImportApplyMcpServerSelection {
	/** Stable id of the source app the server was discovered under. */
	sourceAppId: string
	/** Server name in the source app's config. */
	name: string
}

export type ImportApplyOutcome = "imported" | "skipped" | "error"

/** Per-item result so the client can report exactly what landed and what did not. */
export interface ImportApplyItemResult {
	kind: "skill" | "mcpServer"
	sourceAppId: string
	/** Skill invocation name, or MCP server name. Omitted when the item could not be resolved to a name at apply time. */
	name?: string
	/** Absolute SKILL.md path of the selected item (skills only). */
	path?: string
	outcome: ImportApplyOutcome
	/** Why an item was skipped or failed. Absent for "imported". */
	reason?: string
}

export interface ImportApplyResult {
	results: ImportApplyItemResult[]
	/** Non-fatal persistence problems (e.g. the config write failed after items landed). */
	warnings?: string[]
}

export interface ImportApplyDeps {
	/**
	 * Harness agent config dir (production: `~/.config/kimchi/harness`, set by
	 * entry.ts). Skills are copied to `<agentDir>/skills` — pi loads that dir
	 * natively — and MCP servers merge into `<agentDir>/mcp.json`.
	 */
	readonly agentDir: string
	/**
	 * Path to the global kimchi config.json, where skillPaths and the
	 * migration marker live. Defaults to the real global path; tests inject a
	 * temp file.
	 */
	readonly configPath?: string
	/** Source-app definitions to re-discover. Defaults to AGENT_DEFINITIONS. */
	readonly definitions?: readonly AgentDefinition[]
}

function invalidParams(detail: string): never {
	throw RequestError.invalidParams(undefined, `import_apply: ${detail}`)
}

/** Validated selection; both arrays are always present (possibly empty). */
interface ParsedSelections {
	skills: ImportApplySkillSelection[]
	mcpServers: ImportApplyMcpServerSelection[]
}

function parseParams(params: Record<string, unknown>): ParsedSelections {
	if (params === null || typeof params !== "object" || Array.isArray(params)) {
		invalidParams("params must be an object")
	}
	const raw = params as Record<string, unknown>
	const skills = raw.skills === undefined ? [] : parseSelection<ImportApplySkillSelection>(raw.skills, "skills", "path")
	const mcpServers =
		raw.mcpServers === undefined
			? []
			: parseSelection<ImportApplyMcpServerSelection>(raw.mcpServers, "mcpServers", "name")
	return { skills, mcpServers }
}

function parseSelection<T extends { sourceAppId: string }>(
	value: unknown,
	field: string,
	secondKey: keyof Omit<T, "sourceAppId"> & string,
): T[] {
	if (!Array.isArray(value)) invalidParams(`${field} must be an array`)
	return value.map((entry) => {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			invalidParams(`${field} entries must be objects`)
		}
		const obj = entry as Record<string, unknown>
		if (typeof obj.sourceAppId !== "string" || obj.sourceAppId.length === 0) {
			invalidParams(`${field} entries need a string sourceAppId`)
		}
		if (typeof obj[secondKey] !== "string" || (obj[secondKey] as string).length === 0) {
			invalidParams(`${field} entries need a string ${secondKey}`)
		}
		return { sourceAppId: obj.sourceAppId, [secondKey]: obj[secondKey] } as T
	})
}

/** Skill directory name for the destination: sanitized invocation name, with the source directory's own (already valid) name as a fallback. */
function destinationDirName(skill: DiscoveredSkill): string {
	const sanitized = toSkillName(skill.name)
	if (sanitized.length > 0) return sanitized
	return basename(dirname(skill.path))
}

function applySkills(
	selected: ImportApplySkillSelection[],
	discovered: readonly { id: string; skills: readonly DiscoveredSkill[] }[],
	skillsRoot: string,
): ImportApplyItemResult[] {
	const byKey = new Map<string, DiscoveredSkill>()
	for (const app of discovered) {
		for (const skill of app.skills) {
			byKey.set(`${app.id}\u0000${skill.path}`, skill)
		}
	}

	const results: ImportApplyItemResult[] = []
	for (const sel of selected) {
		const skill = byKey.get(`${sel.sourceAppId}\u0000${sel.path}`)
		if (!skill) {
			// Resolved only by identity (source app + SKILL.md path); the client
			// already knows the name from discover, so none is echoed here.
			results.push({
				kind: "skill",
				sourceAppId: sel.sourceAppId,
				path: sel.path,
				outcome: "skipped",
				reason: "not found at apply time",
			})
			continue
		}
		const name = destinationDirName(skill)
		const srcDir = dirname(skill.path)
		const destDir = join(skillsRoot, name)
		// The copy guard: a skill name already present in Kimchi is skipped,
		// never overwritten — an import must not eat work from an earlier one,
		// and the existing skill stays byte-for-byte unchanged.
		if (resolve(srcDir) === resolve(destDir) || existsSync(destDir)) {
			results.push({
				kind: "skill",
				sourceAppId: sel.sourceAppId,
				path: sel.path,
				name: skill.name,
				outcome: "skipped",
				reason: "already installed",
			})
			continue
		}
		try {
			mkdirSync(skillsRoot, { recursive: true })
			cpSync(srcDir, destDir, { recursive: true })
			results.push({
				kind: "skill",
				sourceAppId: sel.sourceAppId,
				path: sel.path,
				name: skill.name,
				outcome: "imported",
			})
		} catch (err) {
			// One failing item never aborts the rest of the batch.
			results.push({
				kind: "skill",
				sourceAppId: sel.sourceAppId,
				path: sel.path,
				name: skill.name,
				outcome: "error",
				reason: err instanceof Error ? err.message : String(err),
			})
		}
	}
	return results
}

function applyMcpServers(
	selected: ImportApplyMcpServerSelection[],
	discovered: readonly { id: string; mcpServers: Record<string, ServerEntry> }[],
	mcpPath: string,
	warnings: string[],
): ImportApplyItemResult[] {
	const byKey = new Map<string, ServerEntry>()
	for (const app of discovered) {
		for (const [name, entry] of Object.entries(app.mcpServers)) {
			// Same filter as import_discover's toImportDiscoverMcpServer — falsy,
			// so an empty-string command/url is just as unactionable as an absent
			// one: such entries are never reported by discovery and must not be
			// importable by identity either, so the two methods agree on what a
			// selectable server is.
			if (!entry.command && !entry.url) continue
			byKey.set(`${app.id}\u0000${name}`, entry)
		}
	}

	let existing: Record<string, unknown>
	try {
		existing = JSON.parse(readFileSync(mcpPath, "utf-8")) as Record<string, unknown>
		if (existing === null || typeof existing !== "object" || Array.isArray(existing)) existing = {}
	} catch {
		// Missing or corrupt — start fresh (same policy as the terminal wizard).
		existing = {}
	}
	const rawServers = existing.mcpServers
	// Same shape discipline as the root: a file that parses but carries a
	// scalar/array mcpServers (hand-edit or partial-write corruption) must
	// not be object-spread into garbage numeric keys and re-persisted.
	const existingServers =
		rawServers !== null && typeof rawServers === "object" && !Array.isArray(rawServers)
			? (rawServers as Record<string, ServerEntry>)
			: {}

	const results: ImportApplyItemResult[] = []
	const toAdd: Record<string, ServerEntry> = {}
	for (const sel of selected) {
		const entry = byKey.get(`${sel.sourceAppId}\u0000${sel.name}`)
		if (!entry) {
			results.push({
				kind: "mcpServer",
				sourceAppId: sel.sourceAppId,
				name: sel.name,
				outcome: "skipped",
				reason: "not found at apply time",
			})
			continue
		}
		// Existing wins by name: re-importing never clobbers a server the user
		// (or Studio's prefixed connector entries) already has.
		if (existingServers[sel.name] !== undefined || toAdd[sel.name] !== undefined) {
			results.push({
				kind: "mcpServer",
				sourceAppId: sel.sourceAppId,
				name: sel.name,
				outcome: "skipped",
				reason: "already configured",
			})
			continue
		}
		toAdd[sel.name] = entry
		results.push({ kind: "mcpServer", sourceAppId: sel.sourceAppId, name: sel.name, outcome: "imported" })
	}

	if (Object.keys(toAdd).length > 0) {
		// Rewrite only the mcpServers map; every other top-level key in the
		// file (settings, imports, …) is preserved untouched.
		const merged = { ...toAdd, ...existingServers }
		existing.mcpServers = merged
		try {
			writeJsonObjectFile(mcpPath, existing)
		} catch (err) {
			// Partial outcomes are reported, not hidden: skills may already be on
			// disk, so a failed MCP-config write must not reject the call. The
			// affected items are downgraded from "imported" to "error" (they did
			// not land) and a top-level warning names the root cause.
			const reason = `MCP config write failed: ${err instanceof Error ? err.message : String(err)}`
			for (const r of results) {
				if (r.kind === "mcpServer" && r.outcome === "imported") {
					r.outcome = "error"
					r.reason = reason
				}
			}
			warnings.push(`Failed to persist the MCP config: ${err instanceof Error ? err.message : String(err)}`)
		}
	}
	return results
}

/**
 * Stored skill paths are merged, never replaced: a hand-added custom path
 * survives an import. Source apps are never added here — skills are copied,
 * not linked, and registering a source directory would double-discover every
 * skill in it.
 */
function mergeSkillPaths(configPath: string): string[] {
	let stored: string[] = []
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>
		// Server-side data, not client params: non-string entries are dropped
		// rather than surfacing as an invalidParams error to the client.
		if (Array.isArray(parsed.skillPaths)) {
			stored = parsed.skillPaths.filter((p): p is string => typeof p === "string")
		}
	} catch {
		// No config yet — first run; nothing to preserve.
	}
	const seen = new Set<string>()
	const merged: string[] = []
	for (const p of [...ALWAYS_SHOWN_SKILL_PATHS, ...stored]) {
		if (seen.has(p)) continue
		seen.add(p)
		merged.push(p)
	}
	return merged
}

/**
 * Perform the import for a client-supplied selection. Completing the call
 * satisfies the migration marker — even when items were skipped or failed —
 * so a user who imported in one surface is not re-interrogated in the other.
 *
 * Partial outcomes are reported, not hidden: if the final config writes fail
 * (EACCES, disk full) the per-item results still come back, with a top-level
 * `warnings` entry naming what could not be persisted.
 */
export function handleImportApply(deps: ImportApplyDeps, params: Record<string, unknown>): ImportApplyResult {
	const selection = parseParams(params)
	const definitions = deps.definitions ?? AGENT_DEFINITIONS
	// Home scope, same as import_discover: onboarding has no workspace, and
	// project-relative roots are meaningless (and permission-prompting) here.
	const discovered = definitions.map((def) => discoverAgent(def, { scope: "home" }))

	const skillsRoot = join(deps.agentDir, "skills")
	const mcpPath = join(deps.agentDir, "mcp.json")
	const configPath = deps.configPath ?? KIMCHI_CONFIG_PATH

	const warnings: string[] = []
	const results = [
		...applySkills(selection.skills, discovered, skillsRoot),
		...applyMcpServers(selection.mcpServers, discovered, mcpPath, warnings),
	]

	const persistenceWarnings = recordFinalWrites(configPath)
	const allWarnings = [...warnings, ...(persistenceWarnings ?? [])]
	return allWarnings.length > 0 ? { results, warnings: allWarnings } : { results }
}

/**
 * The two completion writes (skill paths + migration marker) run after the
 * items may already be on disk, so a failure must not reject the call and
 * bury the per-item results — it is reported as a warning instead.
 */
function recordFinalWrites(configPath: string): string[] | undefined {
	const warnings: string[] = []
	const steps: Array<{ label: string; run: () => void }> = [
		{ label: "persist skill paths", run: () => writeSkillPaths(mergeSkillPaths(configPath), configPath) },
		{ label: "persist the migration marker", run: () => writeMigrationState("done", configPath) },
	]
	for (const step of steps) {
		try {
			step.run()
		} catch (err) {
			warnings.push(`Failed to ${step.label}: ${err instanceof Error ? err.message : String(err)}`)
		}
	}
	return warnings.length > 0 ? warnings : undefined
}
