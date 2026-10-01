/**
 * Shared ACP wire-format constants for the toolCallId format and the
 * `_meta` extension keys (mid-turn reattach opt-in, lifetime usage totals).
 * Used by both the ACP mode server
 * (`src/modes/acp/server.ts`, which generates ids) and the sandbox worker
 * client (`src/sandbox/worker/acp-client.ts`, which parses them back).
 *
 * These values are cross-version compatibility contracts with running
 * workers — changing either silently degrades every client to its fallback
 * path, so they must stay byte-identical across releases.
 */

import type { LifetimeUsage } from "../../extensions/agents/manager/usage.js"

/** `_meta` key opting `session/load` into mid-turn attach; strict guard stays default. */
export const ACP_REATTACH_MID_TURN_META_KEY = "kimchi/reattachMidTurn"

/**
 * `_meta` key carrying cumulative lifetime token usage on `usage_update`
 * session notifications. ACP's `usage_update` only reports context-window
 * state (used/size), which cannot express consumed-token totals — the server
 * folds its turn usage accumulator into this key so clients can show live
 * token counts for long-running remote agents.
 */
export const ACP_LIFETIME_USAGE_META_KEY = "kimchi/lifetimeUsage"

/**
 * Reads the cumulative lifetime usage totals from a notification's `_meta`.
 * Tolerant by design: absent/shape-mismatched values yield undefined (or 0
 * per field), so a server version without the key degrades gracefully to
 * end-of-prompt usage reporting.
 */
export function readLifetimeUsageMeta(meta: unknown): LifetimeUsage | undefined {
	if (!meta || typeof meta !== "object") return undefined
	const raw = (meta as Record<string, unknown>)[ACP_LIFETIME_USAGE_META_KEY]
	if (!raw || typeof raw !== "object") return undefined
	const u = raw as Record<string, unknown>
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0)
	return {
		input: num(u.input),
		output: num(u.output),
		cacheRead: num(u.cacheRead),
		cacheWrite: num(u.cacheWrite),
	}
}

/** Builds the ACP toolCallId for a tool call: `kt.<toolName>.<seq>`. */
export function buildToolCallId(toolName: string, seq: number): string {
	return `kt.${toolName}.${seq}`
}

/**
 * Parses a `kt.<toolName>.<seq>` id back into its tool name. The tool name
 * itself may contain dots (e.g. `kt.web_fetch.2` → `web_fetch`). Returns
 * null for ids that do not match the format.
 */
export function parseToolCallId(id: string): { toolName: string } | null {
	const match = id.match(/^kt\.(.+?)\.\d+$/)
	return match ? { toolName: match[1] } : null
}
