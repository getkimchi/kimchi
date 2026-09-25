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
//    `{ sessionId, decision: "trust" | "deny" | "deny_persist" }`.
//
// Only the pure payload logic lives here; the KimchiAcpAgent server owns the
// session lookup, persistence, and the palette/prompt refresh sweep.

import { existsSync } from "node:fs"
import { join } from "node:path"
import { type AgentSideConnection, RequestError } from "@agentclientprotocol/sdk"

import { isProjectScopeAllowed } from "../../project-scope-trust.js"
import { AVAILABLE_EXT_NOTIFICATIONS } from "./capabilities.js"

/** Coarse categories the project-trust gate can hold back for a cwd. */
export type BlockedTrustCategory = "skills" | "project_config" | "pi_settings"

/** Tri-state client decision on the trust survey. */
export type ProjectTrustDecision = "trust" | "deny" | "deny_persist"

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
const CATEGORY_PATHS: Record<BlockedTrustCategory, readonly string[]> = {
	skills: [join(".kimchi", "skills"), join(".claude", "skills"), join(".pi", "agent", "skills")],
	project_config: [join(".kimchi", "config.json")],
	pi_settings: [join(".pi", "settings.json")],
}

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
	// Test doubles for AgentSideConnection commonly stub extNotification as
	// `vi.fn()` (returning undefined), so the SDK's Promise<void> return type
	// cannot be trusted at this seam — resolve defensively instead of a bare
	// `.catch` on the (possibly undefined) return value.
	try {
		const sent = conn.extNotification(AVAILABLE_EXT_NOTIFICATIONS.project_trust_update, {
			sessionId: update.sessionId,
			trusted: update.trusted,
			blocked: [...update.blocked],
		})
		Promise.resolve(sent as Promise<void> | undefined).catch((err: unknown) => {
			process.stderr.write(`acp project_trust_update notification failed: ${String(err)}\n`)
		})
	} catch (err) {
		process.stderr.write(`acp project_trust_update notification failed: ${String(err)}\n`)
	}
}

/**
 * Validate the `decision` param of `_kimchi.dev/set_project_trust`.
 *
 * @throws RequestError.invalidParams for anything but the three known values.
 */
export function parseProjectTrustDecision(raw: unknown): ProjectTrustDecision {
	if (raw === "trust" || raw === "deny" || raw === "deny_persist") return raw
	throw RequestError.invalidParams(
		undefined,
		`decision must be one of "trust", "deny", "deny_persist" (got ${JSON.stringify(raw)})`,
	)
}
