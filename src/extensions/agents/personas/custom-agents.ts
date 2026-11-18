/**
 * custom-agents.ts — Load user-defined agents from project, global, and installed-extension locations.
 *
 * Discovery hierarchy (later overwrites earlier):
 *   1. Package: each installed kimchi extension's <pkg>/agents/*.md (lowest)
 *   2. Global:  $KIMCHI_CODING_AGENT_DIR/agents/*.md (default: ~/.config/kimchi/harness/agents/*.md)
 *   3. Project: <cwd>/.kimchi/agents/*.md (highest — overrides everything)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, isAbsolute, join, relative } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { isProjectScopeAllowed } from "../../../project-scope-trust.js"
import { getInstalledPackageResourceDirs } from "../package-resources.js"
import { parseAgentFrontmatter } from "./agent-frontmatter.js"
import { BUILTIN_TOOL_NAMES } from "./agent-types.js"
import type { AgentConfig, ThinkingLevel } from "./types.js"

/** An agent file that was not loaded because its frontmatter is invalid. */
export interface SkippedAgentFile {
	path: string
	/** First line of the parse error. */
	reason: string
}

export interface CustomAgentsLoadResult {
	agents: Map<string, AgentConfig>
	skipped: SkippedAgentFile[]
}

/**
 * Scan for custom agent .md files from multiple locations.
 */
export function loadCustomAgents(cwd: string): CustomAgentsLoadResult {
	const globalDir = join(getAgentDir(), "agents")
	const projectDir = join(cwd, ".kimchi", "agents")

	const result: CustomAgentsLoadResult = { agents: new Map(), skipped: [] }
	for (const pkgDir of getInstalledPackageResourceDirs(cwd, "agents")) {
		loadFromDir(pkgDir, result, "package") // lowest priority
	}
	loadFromDir(globalDir, result, "global") // overrides package
	// Project personas override everything, so they are gated on project
	// trust: an untrusted repo must not inject agent system prompts.
	if (isProjectScopeAllowed(cwd)) {
		loadFromDir(projectDir, result, "project") // overrides everything
	}
	return result
}

/** Closing line of the skipped-files report, on every surface. */
export const SKIPPED_AGENT_FILES_FIX_LINE = "Fix the YAML frontmatter to load them."

/** One file row of the skipped-files report, on every surface (no indent). */
export function formatSkippedAgentFileRow(path: string, reason: string): string {
	return `${path} — ${reason}`
}

/** User-facing warning for the files `loadCustomAgents` skipped. */
export function formatSkippedAgentFiles(skipped: SkippedAgentFile[], cwd: string): string {
	const noun = skipped.length === 1 ? "agent file" : "agent files"
	return [
		`Skipped ${skipped.length} ${noun} with invalid frontmatter (not loaded):`,
		...skipped.map(({ path, reason }) => `  ${formatSkippedAgentFileRow(displayPath(path, cwd), reason)}`),
		SKIPPED_AGENT_FILES_FIX_LINE,
	].join("\n")
}

/** Path as the user should see it: relative to the session cwd when inside it. */
export function displayPath(path: string, cwd: string): string {
	const rel = relative(cwd, path)
	return rel.startsWith("..") || isAbsolute(rel) ? path : rel
}

/** Load agent configs from a directory into the result. */
function loadFromDir(dir: string, result: CustomAgentsLoadResult, source: "project" | "global" | "package"): void {
	if (!existsSync(dir)) return

	let files: string[]
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".md"))
	} catch {
		return
	}

	for (const file of files) {
		const name = basename(file, ".md")
		const path = join(dir, file)

		let content: string
		try {
			content = readFileSync(path, "utf-8")
		} catch {
			continue
		}

		try {
			const { frontmatter: fm, body } = parseAgentFrontmatter(content)
			result.agents.set(name, {
				name,
				displayName: str(fm.display_name),
				description: str(fm.description) ?? name,
				builtinToolNames: csvList(fm.tools, BUILTIN_TOOL_NAMES),
				disallowedTools: csvListOptional(fm.disallowed_tools),
				extensions: inheritField(fm.extensions ?? fm.inherit_extensions),
				skills: inheritField(fm.skills ?? fm.inherit_skills),
				models: modelToArray(fm),
				thinking: str(fm.thinking) as ThinkingLevel | undefined,
				maxTurns: nonNegativeInt(fm.max_turns),
				tokenBudget: positiveInt(fm.token_budget),
				maxDuration: positiveInt(fm.max_duration),
				systemPrompt: body.trim(),
				promptMode: fm.prompt_mode === "append" ? "append" : "replace",
				inheritContext: fm.inherit_context != null ? fm.inherit_context === true : undefined,
				runInBackground: fm.run_in_background != null ? fm.run_in_background === true : undefined,
				isolated: fm.isolated != null ? fm.isolated === true : undefined,
				includeContextFiles: fm.include_context_files != null ? fm.include_context_files === true : undefined,
				includeCoreGuidelines: fm.include_core_guidelines != null ? fm.include_core_guidelines === true : undefined,
				enabled: fm.enabled !== false,
				isolation: fm.isolation === "worktree" ? "worktree" : undefined,
				source,
			})
		} catch (err) {
			// One unparseable file must not take down the other agents — or the
			// harness: this runs inside the extension factory, where a throw is fatal.
			const message = err instanceof Error ? err.message : String(err)
			result.skipped.push({ path, reason: message.split("\n")[0] })
		}
	}
}

// ---- Field parsers ----

function str(val: unknown): string | undefined {
	return typeof val === "string" ? val : undefined
}

function nonNegativeInt(val: unknown): number | undefined {
	return typeof val === "number" && val >= 0 ? val : undefined
}

function positiveInt(val: unknown): number | undefined {
	const n = nonNegativeInt(val)
	return n != null && n > 0 ? n : undefined
}

function parseCsvField(val: unknown): string[] | undefined {
	if (val === undefined || val === null) return undefined
	const s = String(val).trim()
	if (!s || s === "none") return undefined
	const items = s
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean)
	return items.length > 0 ? items : undefined
}

function csvList(val: unknown, defaults: string[]): string[] {
	if (val === undefined || val === null) return defaults
	return parseCsvField(val) ?? []
}

function csvListOptional(val: unknown): string[] | undefined {
	return parseCsvField(val)
}

function modelToArray(fm: Record<string, unknown>): string[] | undefined {
	// New form: `models: [...]` (preferred)
	const arr = csvOrArrayList(fm.models)
	if (arr) return arr
	// Legacy form: `model: "x"` → wrap as single-element array
	const single = str(fm.model)
	if (single && single !== "inherit") return [single]
	return undefined
}

function csvOrArrayList(val: unknown): string[] | undefined {
	if (Array.isArray(val) && val.every((v) => typeof v === "string" && v.length > 0)) {
		return val as string[]
	}
	if (typeof val === "string" && val.trim().length > 0) {
		return parseCsvField(val)
	}
	return undefined
}

function inheritField(val: unknown): true | string[] | false {
	if (val === undefined || val === null || val === true) return true
	if (val === false || val === "none") return false
	const items = csvList(val, [])
	return items.length > 0 ? items : false
}
