// Project-trust surfacing over ACP (LLM-3628 follow-up).
//
// ACP sessions are headless: `resolveHeadlessProjectTrust()` fail-closes to
// untrusted when `defaultProjectTrust` is "ask" (the default) and no decision
// is persisted in <agentDir>/trust.json — silently dropping project-scoped
// skill roots (`.kimchi/skills`, `.claude/skills`) from resources_discover.
// This module gives clients two things:
//
// 1. `project_trust_update` extNotifications (push after session creation and
//    after any decision change): `{ sessionId, trusted, blocked }` where
//    `blocked` is a coarse category list, never per-file paths of the
//    untrusted repo (info-leak footgun).
// 2. The `_kimchi.dev/set_project_trust` ext method payload contract:
//    `{ sessionId, decision: "trust" | "trust_session" | "trust_parent" | "deny" | "deny_persist" }`.
//
// Only the pure payload logic lives here; the KimchiAcpAgent server owns the
// session lookup, persistence, and the palette/prompt refresh sweep.

import { existsSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { type AgentSideConnection, RequestError } from "@agentclientprotocol/sdk"
import type { ProjectTrustStore } from "@earendil-works/pi-coding-agent"

import { isProjectScopeAllowed } from "../../project-scope-trust.js"
import { AVAILABLE_EXT_NOTIFICATIONS } from "./capabilities.js"

/** Coarse categories the project-trust gate can hold back for a cwd. */
export type BlockedTrustCategory = "skills" | "project_config" | "pi_settings"

/** Trust-survey decisions. Mirrored from the TUI prompt's options. */
export type ProjectTrustDecision = "trust" | "trust_session" | "trust_parent" | "deny" | "deny_persist"

/** Push payload delivered as the `_kimchi.dev/project_trust_update` extNotification. */
export interface ProjectTrustUpdate {
	readonly sessionId: string
	readonly trusted: boolean
	readonly blocked: readonly BlockedTrustCategory[]
}

/**
 * Conventional paths per blocked category. Existence-based and deliberately
 * coarse: the update tells the client *what kind* of resource is gated, never
 * which files exist in the untrusted repo.
 */
export const CATEGORY_PATHS: Record<BlockedTrustCategory, readonly string[]> = {
	skills: [join(".kimchi", "skills"), join(".claude", "skills"), join(".pi", "agent", "skills")],
	project_config: [join(".kimchi", "config.json")],
	pi_settings: [join(".pi", "settings.json")],
}

/**
 * Gated readers deliberately NOT surfaced as a blocked category (yet). Every
 * entry in TRUST_REQUIRING_PROJECT_RESOURCES must appear in CATEGORY_PATHS or
 * here — a unit test cross-checks it — so a newly gated reader can never be
 * silently invisible to ACP clients.
 *
 * Why these are held back: the client-facing payload stays coarse, and each
 * would need a product decision on its category vocabulary — e.g.
 * `.kimchi/mcp.json` wants an `mcp_servers` category (deferred review
 * finding), permissions/hooks/agents/memory are project_config-adjacent
 * kimchi state, `.claude/settings*.json` is Claude Code config, and
 * tags/plans/ferments are workflow state Studio does not render banners for.
 */
export const UNCLASSIFIED_TRUST_PATHS: readonly string[] = [
	join(".kimchi", "permissions.json"),
	join(".kimchi", "permissions.local.json"),
	join(".kimchi", "hooks.json"),
	join(".kimchi", "hooks.local.json"),
	join(".kimchi", "hooks"),
	join(".kimchi", "agents"),
	join(".kimchi", "agents.json"),
	join(".kimchi", "agent-memory"),
	join(".kimchi", "agent-memory-local"),
	join(".kimchi", "mcp.json"),
	join(".kimchi", "tags.json"),
	join(".kimchi", "plans"),
	join(".kimchi", "ferments"),
	join(".claude", "settings.json"),
	join(".claude", "settings.local.json"),
]

/**
 * Categories that would be gated for `cwd` were it untrusted. Pure fs probe
 * (no trust check) so callers can compose: `{ trusted, blocked: trusted ? [] :
 * computeBlockedTrustCategories(cwd) }`.
 */
export function computeBlockedTrustCategories(
	cwd: string,
	exists: (path: string) => boolean = existsSync,
): BlockedTrustCategory[] {
	const blocked: BlockedTrustCategory[] = []
	for (const category of Object.keys(CATEGORY_PATHS) as BlockedTrustCategory[]) {
		if (CATEGORY_PATHS[category].some((rel) => exists(join(cwd, rel)))) blocked.push(category)
	}
	return blocked
}

/** The push payload for a session cwd under the *current* gate state. */
export function buildProjectTrustUpdate(sessionId: string, cwd: string): ProjectTrustUpdate {
	const trusted = isProjectScopeAllowed(cwd)
	return {
		sessionId,
		trusted,
		blocked: trusted ? [] : computeBlockedTrustCategories(cwd),
	}
}

/**
 * Push the trust state for a session. Fire-and-forget like notifyDroppedQueue:
 * callers are synchronous event paths and the ACP SDK serializes outbound
 * writes, so ordering against surrounding sessionUpdate calls is preserved
 * without awaiting. Unaware clients ignore unknown ext notifications.
 */
export function notifyProjectTrustUpdate(conn: AgentSideConnection, update: ProjectTrustUpdate): void {
	conn
		.extNotification(AVAILABLE_EXT_NOTIFICATIONS.project_trust_update, {
			sessionId: update.sessionId,
			trusted: update.trusted,
			blocked: [...update.blocked],
		})
		.catch((err: unknown) => {
			process.stderr.write(`acp project_trust_update notification failed: ${String(err)}\n`)
		})
}

/**
 * Validate the `decision` param of `_kimchi.dev/set_project_trust`.
 *
 * @throws RequestError.invalidParams for anything but the five known values.
 */
export function parseProjectTrustDecision(raw: unknown): ProjectTrustDecision {
	if (
		raw === "trust" ||
		raw === "trust_session" ||
		raw === "trust_parent" ||
		raw === "deny" ||
		raw === "deny_persist"
	) {
		return raw
	}
	throw RequestError.invalidParams(
		undefined,
		`decision must be one of "trust", "trust_session", "trust_parent", "deny", "deny_persist" (got ${JSON.stringify(raw)})`,
	)
}

/**
 * Validate the `decision` param of `_kimchi.dev/set_path_trust`.
 *
 * Persisted semantics only: session-scoped decisions
 * (trust_session/trust_parent/deny_persist) belong to the session-bound
 * method; this one writes the store for an arbitrary path.
 *
 * @throws RequestError.invalidParams for anything but "trust"/"deny".
 */
export function parsePathTrustDecision(raw: unknown): "trust" | "deny" {
	if (raw === "trust" || raw === "deny") return raw
	throw RequestError.invalidParams(undefined, `decision must be "trust" or "deny" (got ${JSON.stringify(raw)})`)
}

/** Resolved trust state of a path — the response of get/set_path_trust. */
export interface PathTrustInfo {
	/** Whether any store entry (this path or an ancestor) decides the state. */
	readonly decided: boolean
	/** The resolved decision; undecided paths are fail-closed (false). */
	readonly trusted: boolean
	/** Coarse categories gated while untrusted (empty when trusted). */
	readonly blocked: readonly BlockedTrustCategory[]
	/** Canonicalized path of the nearest deciding entry; null when undecided. */
	readonly decisionSource: string | null
}

/**
 * Resolve a path's trust state through the store's nearest-wins ancestor
 * walk — the same resolution a session cwd would get. Clients never need to
 * reimplement the walk (or its canonicalization rules — the trailing-slash
 * and /var-vs-/private/var hand-edit traps both live here, behind the API).
 */
export function buildPathTrustInfo(store: ProjectTrustStore, path: string): PathTrustInfo {
	const entry = store.getEntry(path)
	const trusted = entry?.decision === true
	return {
		decided: entry !== null,
		trusted,
		blocked: trusted ? [] : computeBlockedTrustCategories(path),
		decisionSource: entry?.path ?? null,
	}
}

/**
 * Validate the `path` param of the sessionless trust methods: non-empty
 * absolute path. Relative paths are rejected — they would silently resolve
 * against the agent process's cwd, which no client can predict.
 *
 * @throws RequestError.invalidParams when missing or relative.
 */
export function requireAbsolutePath(raw: unknown): string {
	if (typeof raw !== "string" || raw.length === 0) {
		throw RequestError.invalidParams(undefined, "path must be a non-empty absolute path string")
	}
	if (!isAbsolute(raw)) {
		throw RequestError.invalidParams(undefined, `path must be absolute (got ${JSON.stringify(raw)})`)
	}
	return raw
}

/** The wire form of {@link PathTrustInfo} — plain JSON-RPC result record. */
export function pathTrustResponse(info: PathTrustInfo): Record<string, unknown> {
	return { ...info, blocked: [...info.blocked] }
}

/**
 * The directory a `trust_parent` decision grants: literally one level up,
 * mirroring pi's `getProjectTrustParentPath` (the TUI's "Trust parent
 * folder" option is single-level by design). Undefined at the filesystem
 * root, where no parent exists.
 */
export function parentTrustPath(cwd: string): string | undefined {
	const parent = dirname(resolve(cwd))
	return parent === resolve(cwd) ? undefined : parent
}

/** True when `child` is `ancestor` itself or lives somewhere beneath it. */
export function isPathWithin(child: string, ancestor: string): boolean {
	const rel = relative(resolve(ancestor), resolve(child))
	if (rel === "") return true
	// Windows cross-drive relatives come back absolute (e.g. `D:\x`) — a
	// different drive is by definition outside the ancestor.
	if (isAbsolute(rel)) return false
	return rel !== ".." && !rel.startsWith(`..${sep}`)
}
