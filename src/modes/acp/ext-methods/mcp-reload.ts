// ACP extension method handler for `_kimchi.dev/reload_mcp_config` — the
// restart-free MCP config hot-apply (D1/D3): Studio calls one sessionless
// ext method after an MCP config change; the handler fans out to every live
// session's MCP adapter instance through the per-session reload-handle
// registry, applies the idle gate (not mid-turn AND not compacting), and
// aggregates the per-session outcomes into the wire result. Each cleanly
// applied session additionally emits one `_kimchi.dev/mcp_config_applied`
// notification after the response (ADR-0041 shape; clients drop
// notifications for sessions they have not registered, so busy/refused/error
// sessions do not notify — their truth is in the result).

import { type AgentSideConnection, RequestError } from "@agentclientprotocol/sdk"
import type { ReloadConfigOptions, SessionReloadOutcome } from "pi-mcp-adapter/types"
import { getReloadHandle } from "../../../extensions/mcp/reload-registry.js"
import { AVAILABLE_EXT_NOTIFICATIONS } from "../capabilities.js"
import { emitExtNotification } from "../ext-notifications.js"

/** The applied-diff buckets, in the adapter's SessionReloadOutcome vocabulary. */
export interface McpReloadDiffBuckets {
	added: string[]
	removed: string[]
	changed: string[]
	unchanged: string[]
	blocked: Array<{ name: string; blockedReason: string }>
	needsAuth: string[]
}

/** Per-session outcome on the wire. */
export interface McpReloadSessionResult {
	sessionId: string
	status: "applied" | "busy" | "refused" | "error" | "no_extension"
	/** Only when status === "error". */
	error?: string
	/** The applied diff; present for applied/refused/error sessions that produced one. */
	servers?: McpReloadDiffBuckets
}

/** Result of `_kimchi.dev/reload_mcp_config` on the wire. */
export interface McpReloadResult {
	/** Echo of the caller-minted applyToken, or null when not supplied. */
	applyToken: string | null
	/** False → the caller falls back to its busy-deferred restart path. */
	applied: boolean
	fallbackReason: null | "sessions_busy" | "direct_tools_frozen" | "no_mcp_extension" | "error"
	sessions: McpReloadSessionResult[]
}

/** What the handler needs from each live session, snapshotted at apply time. */
export interface McpReloadSessionSnapshot {
	sessionId: string
	/** A turn is truly active (defined and not cancelled) — the turn half of the idle gate. */
	turnActive: boolean
	/** Compaction runs outside turn bookkeeping; it is the second, mandatory idle-gate half. */
	isCompacting: boolean
	reloadToken?: string
}

export interface HandleReloadMcpConfigDeps {
	/**
	 * Live (non-disposed) ACP sessions as idle/busy snapshots, re-read lazily.
	 * The callback runs INSIDE the serialized reload section so the idle gate is
	 * evaluated at apply time, not on a snapshot taken at request time: a
	 * session that started a turn or a compaction while this reload waited on
	 * the FIFO must still be seen as busy (§3.4).
	 */
	getSessions: () => McpReloadSessionSnapshot[]
	conn: AgentSideConnection
}

/** Wire validation, mirroring validateServerEntry's structural-guard style. */
export function validateReloadParams(params: Record<string, unknown>): { servers?: string[]; applyToken?: string } {
	const { servers, applyToken } = params as { servers?: unknown; applyToken?: unknown }
	if (servers !== undefined) {
		if (!Array.isArray(servers)) {
			throw RequestError.invalidParams(undefined, "'servers' must be an array of strings")
		}
		for (const name of servers) {
			if (typeof name !== "string") {
				throw RequestError.invalidParams(undefined, "'servers' must be an array of strings")
			}
		}
	}
	if (applyToken !== undefined && typeof applyToken !== "string") {
		throw RequestError.invalidParams(undefined, "'applyToken' must be a string")
	}
	return {
		...(servers !== undefined ? { servers: servers as string[] } : {}),
		...(typeof applyToken === "string" ? { applyToken } : {}),
	}
}

function bucketsOf(outcome: SessionReloadOutcome): McpReloadDiffBuckets {
	return {
		added: [...outcome.added],
		removed: [...outcome.removed],
		changed: [...outcome.changed],
		unchanged: [...outcome.unchanged],
		blocked: outcome.blocked.map((entry) => ({ name: entry.name, blockedReason: entry.blockedReason })),
		needsAuth: [...outcome.needsAuth],
	}
}

function outcomeError(outcome: SessionReloadOutcome): string {
	if (outcome.error !== undefined) return outcome.error
	const first = outcome.serverErrors[0]
	if (first !== undefined) return `${first.name}: ${first.message}`
	return "MCP reload failed"
}

/**
 * Own process-wide FIFO chain: reloads must not interleave per-session diffs.
 * Deliberately NOT the probe mutex — a live-session reload creates no OAuth
 * listener; the interactive-auth race is guarded per-server by hasPendingAuth
 * inside the adapter's reload.
 */
let reloadChain: Promise<unknown> = Promise.resolve()

function runSerializedReload<T>(run: () => Promise<T>): Promise<T> {
	const next = reloadChain.then(run, run)
	// Keep the chain alive after a failed reload; surface the error only to
	// this call's caller.
	reloadChain = next.catch(() => {})
	return next
}

/** Handler for `_kimchi.dev/reload_mcp_config`. See module docs. */
export async function handleReloadMcpConfig(
	deps: HandleReloadMcpConfigDeps,
	params: Record<string, unknown>,
): Promise<McpReloadResult> {
	const { servers, applyToken } = validateReloadParams(params)
	return runSerializedReload(() => applyReloadAcrossSessions(deps, servers, applyToken ?? null))
}

async function applyReloadAcrossSessions(
	deps: HandleReloadMcpConfigDeps,
	servers: string[] | undefined,
	applyToken: string | null,
): Promise<McpReloadResult> {
	// Snapshot inside the serialized section (this runs after any FIFO wait).
	const sessions = deps.getSessions()
	const reloadOpts: ReloadConfigOptions | undefined = servers !== undefined ? { servers } : undefined
	const sessionResults: McpReloadSessionResult[] = []
	const appliedSessions: Array<{ sessionId: string; diff: McpReloadDiffBuckets }> = []
	let anyBusy = false
	let anyRefused = false
	let anyError = false

	for (const entry of sessions) {
		// Idle gate (§3.4): not mid-turn AND not compacting. Compaction runs
		// outside turn bookkeeping (that is why prompt() gates on it
		// separately), so the turn check alone would let a reload mutate the
		// tool surface mid-compaction. A non-idle session mutates nothing and
		// reports busy; the caller re-tries at the idle transition.
		if (entry.turnActive || entry.isCompacting) {
			anyBusy = true
			sessionResults.push({ sessionId: entry.sessionId, status: "busy" })
			continue
		}
		const handle = entry.reloadToken !== undefined ? getReloadHandle(entry.reloadToken) : undefined
		if (!handle) {
			// Registry entries without a live handle are skipped as
			// no_extension — a session whose MCP adapter extension has no
			// reload capability (e.g. an older pinned adapter).
			sessionResults.push({ sessionId: entry.sessionId, status: "no_extension" })
			continue
		}
		try {
			const outcome = await handle.reload(reloadOpts)
			if (outcome.status === "refused") {
				anyRefused = true
				sessionResults.push({ sessionId: entry.sessionId, status: "refused", servers: bucketsOf(outcome) })
				continue
			}
			if (outcome.status === "error") {
				anyError = true
				const diff = bucketsOf(outcome)
				sessionResults.push({
					sessionId: entry.sessionId,
					status: "error",
					error: outcomeError(outcome),
					servers: diff,
				})
				continue
			}
			const diff = bucketsOf(outcome)
			sessionResults.push({ sessionId: entry.sessionId, status: "applied", servers: diff })
			appliedSessions.push({ sessionId: entry.sessionId, diff })
		} catch (error) {
			anyError = true
			const message = error instanceof Error ? error.message : String(error)
			sessionResults.push({ sessionId: entry.sessionId, status: "error", error: message })
		}
	}

	// Aggregation: applied iff every session that has the extension applied
	// cleanly (empty-diff sessions count as applied). Retry-first semantics:
	// busy wins over refused (the refusal resurfaces on the retry), and over
	// error (the retry re-runs the reconcile). No handles at all →
	// no_mcp_extension.
	const fallbackReason: McpReloadResult["fallbackReason"] = anyBusy
		? "sessions_busy"
		: anyRefused
			? "direct_tools_frozen"
			: anyError
				? "error"
				: appliedSessions.length === 0
					? "no_mcp_extension"
					: null

	// One `_kimchi.dev/mcp_config_applied` per applied session, all sharing
	// the caller's applyToken — scheduled setImmediate-after-response (the
	// scheduleProjectTrustUpdate precedent): the SDK serializes outbound
	// writes, and the response is on the wire before the check phase runs.
	for (const applied of appliedSessions) {
		const payload = {
			sessionId: applied.sessionId,
			applyToken,
			applied: applied.diff,
		}
		setImmediate(() => {
			emitExtNotification(deps.conn, AVAILABLE_EXT_NOTIFICATIONS.mcp_config_applied, payload)
		})
	}

	return {
		applyToken,
		applied: fallbackReason === null,
		fallbackReason,
		sessions: sessionResults,
	}
}
