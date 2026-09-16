import { dirname, resolve } from "node:path"

/**
 * Process-wide gate for project-scoped Kimchi and Claude Code resources
 * (`.kimchi/`, `.claude/`).
 *
 * Detection lives upstream of this module: the trust-scan extension in
 * `patches/@earendil-works__pi-coding-agent@0.84.1.patch` makes pi's
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
