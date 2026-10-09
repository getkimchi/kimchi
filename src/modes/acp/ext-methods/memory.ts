// ACP extension method handlers for memory control — the client-built
// interface that mirrors the /memory command grammar (admin.ts), so IDEs
// render their own memory panels and toggles instead of driving the
// TUI-oriented slash command over the prompt path.
//
// Wire names (`_kimchi.dev/…`, advertised via _meta["kimchi.dev"]):
//   memory_status       — feature + session toggle state + store overview
//   set_memory_enabled  — flip the session-scoped runtime toggle
//   memory_list         — paginated facts across the selected scopes
//   memory_search       — ranked search across the selected scopes
//   memory_delete       — delete facts by id
//   memory_reset        — wipe a scope (requires an explicit confirm)
//
// The store ops are sessionless: memory stores are on-disk and per-machine,
// manageable regardless of the feature resource's state. The state ops
// resolve a live session via sessionId — the toggle lands in the shared
// session-toggle module keyed by that session's manager, which the memory
// extension reads at its next agent start (flip detection resets the digest).
//
// The persistent/global switch is deliberately NOT here: it is the
// extensions.memory resource (set_resource_enabled, restart required). The
// session toggle is runtime state only.

import { RequestError } from "@agentclientprotocol/sdk"
import type { AgentSession } from "@earendil-works/pi-coding-agent"
import {
	type AdminDeps,
	adminDeleteFacts,
	adminListFacts,
	adminOverview,
	adminSearchFacts,
	runAdminCommand,
	scopeFilterFromParams,
} from "../../../extensions/memory/admin.js"
import { MEMORY_RESOURCE_ID } from "../../../extensions/memory/config.js"
import { getSessionMemoryOverride, setSessionMemoryOverride } from "../../../extensions/memory/session-toggle.js"
import { isResourceEnabled } from "../../../resources/store.js"

/** Test seams + the cwd fallback for scope resolution. */
export type MemoryMethodOptions = {
	/** Store seams — defaults to the real on-disk backend. */
	deps?: AdminDeps
	/**
	 * cwd for local/project scope resolution when the client passes none.
	 * Defaults to the server process cwd; outside a repository the local
	 * scope degrades to personal-only.
	 */
	cwd?: string
}

const DEFAULT_LIST_LIMIT = 50

function resolveCwd(options: MemoryMethodOptions): string {
	return options.cwd ?? process.cwd()
}

function requireSessionId(params: Record<string, unknown>): string {
	const sessionId = params.sessionId
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		throw RequestError.invalidParams(undefined, "sessionId is required and must be a non-empty string")
	}
	return sessionId
}

function requireSession(
	getSession: (sessionId: string) => AgentSession | undefined,
	params: Record<string, unknown>,
): { sessionId: string; session: AgentSession } {
	const sessionId = requireSessionId(params)
	const session = getSession(sessionId)
	if (!session) {
		throw RequestError.invalidParams(undefined, `unknown sessionId ${sessionId}`)
	}
	return { sessionId, session }
}

/**
 * Resolve the scope params shared by the store ops via the admin grammar's
 * own mapping — one scope implementation, every surface.
 */
function requireScopeFilter(params: Record<string, unknown>, options: MemoryMethodOptions) {
	const scope = scopeFilterFromParams(params, { cwd: resolveCwd(options) })
	if ("error" in scope) {
		throw RequestError.invalidParams(undefined, scope.error)
	}
	return scope
}

/**
 * Handler for the `_kimchi.dev/memory_status` ACP extension method.
 *
 * Reports both control layers plus the store overview: the feature resource
 * state (persistent, restart-required), the session's toggle override and
 * effective state, and the structured overview data (stores, pending jobs).
 */
export async function handleMemoryStatus(
	getSession: (sessionId: string) => AgentSession | undefined,
	options: MemoryMethodOptions,
	params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const { session } = requireSession(getSession, params)
	const override = getSessionMemoryOverride(session.sessionManager)
	const overview = await adminOverview(options.deps)
	return {
		featureEnabled: isResourceEnabled(MEMORY_RESOURCE_ID),
		sessionOverride: override ?? null,
		sessionActive: override ?? true,
		...overview,
	}
}

/**
 * Handler for the `_kimchi.dev/set_memory_enabled` ACP extension method.
 *
 * Flips the session-scoped memory toggle. Takes effect from the session's
 * next agent start. Rejected when the memory feature resource is disabled —
 * the extension is not loaded in that session, so no runtime would ever read
 * the flag (the persistent switch is set_resource_enabled on
 * extensions.memory, restart required).
 *
 * @throws RequestError.invalidParams on a missing/unknown session, a mistyped
 *   `enabled`, or when the feature resource is off.
 */
export function handleSetMemoryEnabled(
	getSession: (sessionId: string) => AgentSession | undefined,
	params: Record<string, unknown>,
): Record<string, unknown> {
	const { sessionId, session } = requireSession(getSession, params)
	const enabled = params.enabled
	if (typeof enabled !== "boolean") {
		throw RequestError.invalidParams(undefined, "enabled is required and must be a boolean")
	}
	if (!isResourceEnabled(MEMORY_RESOURCE_ID)) {
		throw RequestError.invalidParams(
			undefined,
			'the memory feature is disabled — enable it via set_resource_enabled (resourceId "extensions.memory") and restart the session',
		)
	}
	setSessionMemoryOverride(session.sessionManager, enabled)
	return { sessionId, enabled }
}

/**
 * Handler for the `_kimchi.dev/memory_list` ACP extension method.
 *
 * Paginated facts across the selected scopes, newest first (same ordering and
 * default limit as the /memory list op).
 *
 * @throws RequestError.invalidParams on an invalid scope/project combination
 *   or non-integer limit/offset.
 */
export async function handleMemoryList(
	options: MemoryMethodOptions,
	params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const scope = requireScopeFilter(params, options)
	const { limit, offset } = resolvePageParams(params)
	const all = await adminListFacts(scope, options.deps)
	const page = limit === "all" ? all.slice(offset) : all.slice(offset, offset + limit)
	return {
		total: all.length,
		offset,
		limit,
		scope,
		facts: page.map(({ scopeId, ...item }) => ({ scope: scopeId, ...item })),
	}
}

/**
 * Handler for the `_kimchi.dev/memory_search` ACP extension method.
 *
 * Ranked search hits with scores across the selected scopes (needs the
 * gateway for the query embedding — errors surface as internalError).
 *
 * @throws RequestError.invalidParams on a missing query or an invalid
 *   scope/project combination.
 */
export async function handleMemorySearch(
	options: MemoryMethodOptions,
	params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const query = params.query
	if (typeof query !== "string" || query.trim().length === 0) {
		throw RequestError.invalidParams(undefined, "query is required and must be a non-empty string")
	}
	const scope = requireScopeFilter(params, options)
	try {
		const hits = await adminSearchFacts(query, scope, options.deps)
		return {
			query,
			scope,
			results: hits.map(({ scopeId, ...item }) => ({ scope: scopeId, ...item })),
		}
	} catch (error) {
		// Search needs the embedding gateway; a failure is environmental, not
		// a params problem.
		const detail = error instanceof Error ? error.message : String(error)
		throw RequestError.internalError(undefined, `memory search failed: ${detail}`)
	}
}

/**
 * Handler for the `_kimchi.dev/memory_delete` ACP extension method.
 *
 * Deletes facts by id across all stores. Unknown ids come back in `notFound`
 * (mirroring the CLI op) rather than failing the whole call.
 *
 * @throws RequestError.invalidParams when `ids` is missing, empty, or
 *   contains non-strings.
 */
export async function handleMemoryDelete(
	options: MemoryMethodOptions,
	params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const raw = params.ids
	if (!Array.isArray(raw) || raw.length === 0 || raw.some((id) => typeof id !== "string" || id.length === 0)) {
		throw RequestError.invalidParams(undefined, "ids is required and must be a non-empty array of memory ids")
	}
	const ids = raw as string[]
	const { deleted, notFound } = await adminDeleteFacts(ids, options.deps)
	return { deleted, notFound }
}

/**
 * Handler for the `_kimchi.dev/memory_reset` ACP extension method.
 *
 * Destructive: wipes the named scope through the same reset path the /memory
 * command uses (capture lock held, wipe semantics unchanged). The client owns
 * its confirmation UI — the call itself must carry `confirm: true`, mirroring
 * `--yes` on the CLI. `local` is not a valid reset scope (the grammar rejects
 * it too: wiping "wherever I am" is too easy to run by accident).
 *
 * @throws RequestError.invalidParams when `confirm` is not true, the scope is
 *   missing/invalid, or the reset ran into a client-side problem (e.g. no
 *   such store). Environmental failures surface as internalError.
 */
export async function handleMemoryReset(
	options: MemoryMethodOptions,
	params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	if (params.confirm !== true) {
		throw RequestError.invalidParams(
			undefined,
			"confirm must be true — the client is responsible for confirming before calling memory_reset",
		)
	}
	const scope = params.scope
	if (scope !== "personal" && scope !== "project" && scope !== "all") {
		throw RequestError.invalidParams(undefined, 'scope must be one of "personal", "project", or "all"')
	}
	if (params.project !== undefined && scope !== "project") {
		throw RequestError.invalidParams(undefined, 'project pairs with scope "project" only')
	}
	if (scope === "project" && typeof params.project !== "string") {
		throw RequestError.invalidParams(undefined, 'scope "project" requires the project id (owner/name)')
	}
	if (params.cwd !== undefined && typeof params.cwd !== "string") {
		throw RequestError.invalidParams(undefined, "cwd must be a string")
	}

	// Threaded through the shared grammar so the reset path (lock, wipe,
	// markers) stays single-sourced in admin.ts.
	const args = ["reset", "--scope", scope]
	if (typeof params.project === "string") args.push("--project", params.project)
	args.push("--yes")
	const result = await runAdminCommand(args, {
		cwd: typeof params.cwd === "string" ? params.cwd : resolveCwd(options),
		deps: options.deps,
	})
	if (result.code !== 0) {
		// The dominant failure is a client-side one (no such store, bad
		// project id); lock/fs failures flatten here too — both carry the
		// rendered reason.
		throw RequestError.invalidParams(undefined, result.text)
	}
	const data = JSON.parse(result.json) as Record<string, unknown>
	return { ok: true, ...data }
}

function resolvePageParams(params: Record<string, unknown>): { limit: number | "all"; offset: number } {
	let limit: number | "all" = DEFAULT_LIST_LIMIT
	if (params.limit === "all") {
		limit = "all"
	} else if (params.limit !== undefined) {
		if (typeof params.limit !== "number" || !Number.isInteger(params.limit) || params.limit < 0) {
			throw RequestError.invalidParams(undefined, 'limit must be a non-negative integer or "all"')
		}
		limit = params.limit
	}
	let offset = 0
	if (params.offset !== undefined) {
		if (typeof params.offset !== "number" || !Number.isInteger(params.offset) || params.offset < 0) {
			throw RequestError.invalidParams(undefined, "offset must be a non-negative integer")
		}
		offset = params.offset
	}
	return { limit, offset }
}
