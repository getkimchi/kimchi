import { dirname, resolve } from "node:path"

/**
 * Project-local entries (relative to a directory) whose presence makes a
 * folder trust-requiring for the Kimchi harness: config, permissions, hooks
 * (bash, kimchi-native, claude), skills, agents, memory, MCP servers, tags,
 * plans, and ferments.
 *
 * This is the single source of truth for kimchi-side detection. The pi patch
 * (patches/@earendil-works__pi-coding-agent@0.85.1.patch) embeds the same
 * list in KIMCHI_TRUST_REQUIRING_PROJECT_RESOURCES inside pi's
 * hasTrustRequiringProjectResources (checked in cwd and ancestors, with the
 * user's home excluded); a unit test in project-scope-trust.test.ts
 * cross-checks the two so a newly gated reader cannot silently miss the scan.
 */
export const TRUST_REQUIRING_PROJECT_RESOURCES: readonly string[] = [
	".kimchi/config.json",
	".kimchi/permissions.json",
	".kimchi/permissions.local.json",
	".kimchi/hooks.json",
	".kimchi/hooks.local.json",
	".kimchi/hooks",
	".kimchi/skills",
	".kimchi/agents",
	".kimchi/agents.json",
	".kimchi/agent-memory",
	".kimchi/agent-memory-local",
	".kimchi/mcp.json",
	".kimchi/tags.json",
	".kimchi/plans",
	".kimchi/ferments",
	".pi/agent/skills",
	".claude/skills",
	".claude/settings.json",
	".claude/settings.local.json",
]

/**
 * Process-wide gate for project-scoped Kimchi and Claude Code resources
 * (`.kimchi/`, `.claude/`).
 *
 * Detection lives upstream of this module: the trust-scan extension in
 * `patches/@earendil-works__pi-coding-agent@0.85.1.patch` makes pi's
 * `hasTrustRequiringProjectResources` treat those folders as trust-requiring,
 * so pi prompts (or fail-closes headlessly) before loading anything. This
 * gate is the enforcement side: every kimchi-side reader of project-local
 * resources — `loadConfig()`, permissions, bash hooks, skill roots, agents
 * settings/personas/memory, tags, ferment objective files — must consult
 * `isProjectScopeAllowed()` and skip project/local scope while it is closed.
 *
 * Fails closed: a cwd with no recorded decision is untrusted, so a cloned
 * repo's project-local config (endpoint, API key, skill paths), permissions,
 * hooks, skills, agents, memory, tags, and plans stay inert until trust is
 * established.
 *
 * Decisions are keyed by cwd and resolved ancestor-first (nearest recorded
 * cwd-or-ancestor wins), mirroring pi's `ProjectTrustStore` lookup: one
 * decision covers a whole working tree, and ancestor-walking readers
 * (`.kimchi/skills`, `.kimchi/tags.json`) are gated by the session cwd's
 * decision. Cwd-keying also keeps concurrent ACP sessions in one process
 * isolated from each other's trust decisions.
 *
 * The gate is set from two places, both after trust has been settled:
 * - `settingsTrustSyncExtension` on every session_start (pi resolves project
 *   trust before extensions load), and
 * - the ACP server's `createSessionSettings` after its headless resolution.
 */
const projectScopeTrustByCwd = new Map<string, boolean>()

/** Record the project-trust decision for a session cwd. */
export function setProjectScopeTrusted(cwd: string, trusted: boolean): void {
	projectScopeTrustByCwd.set(resolve(cwd), trusted)
}

/**
 * Whether project-scoped resources under `cwd` (default: the process cwd) may
 * take effect. Returns the nearest recorded decision for cwd or one of its
 * ancestors; no recorded decision means untrusted.
 */
export function isProjectScopeAllowed(cwd: string = process.cwd()): boolean {
	let current = resolve(cwd)
	while (true) {
		const decision = projectScopeTrustByCwd.get(current)
		if (decision !== undefined) return decision
		const parent = dirname(current)
		if (parent === current) return false
		current = parent
	}
}

/** Test hook: forget every recorded decision. */
export function resetProjectScopeTrustForTests(): void {
	projectScopeTrustByCwd.clear()
}
