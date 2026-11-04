// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { homedir } from "node:os"
import { basename, join } from "node:path"

/**
 * Where a tool config writer should target.
 *
 * - `global`: the tool's normal user-level config path, with `~` expanded.
 * - `project`: a per-repo override under `<cwd>/.claude/<basename>` so a
 *   project can pin tool configuration locally without touching the user
 *   config. The basename is taken from the tool's canonical config path,
 *   so an OpenCode setting at `~/.config/opencode/opencode.json` lands at
 *   `<cwd>/.claude/opencode.json` in project scope.
 */
export type ConfigScope = "global" | "project"

export function resolveScopePath(scope: ConfigScope, toolConfigPath: string): string {
	if (scope === "global") {
		if (toolConfigPath.startsWith("~/")) {
			return join(homedir(), toolConfigPath.slice(2))
		}
		if (toolConfigPath === "~") {
			return homedir()
		}
		return toolConfigPath
	}

	if (scope === "project") {
		return join(process.cwd(), ".claude", basename(toolConfigPath))
	}

	throw new Error(`Unknown config scope: ${scope as string}`)
}

export function parseScope(value: string | undefined): ConfigScope {
	if (value === undefined || value === "" || value === "global") return "global"
	if (value === "project") return "project"
	throw new Error(`Invalid scope: ${value} (use 'global' or 'project')`)
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
