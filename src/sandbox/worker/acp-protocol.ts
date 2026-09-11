/**
 * Shared ACP wire-format constants for the toolCallId format and the
 * reattach `_meta` key. Used by both the ACP mode server
 * (`src/modes/acp/server.ts`, which generates ids) and the sandbox worker
 * client (`src/sandbox/worker/acp-client.ts`, which parses them back).
 *
 * These values are cross-version compatibility contracts with running
 * workers — changing either silently degrades every client to its fallback
 * path, so they must stay byte-identical across releases.
 */

/** `_meta` key opting `session/load` into mid-turn attach; strict guard stays default. */
export const ACP_REATTACH_MID_TURN_META_KEY = "kimchi/reattachMidTurn"

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
