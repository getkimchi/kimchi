/**
 * Work attribution for MCP tool calls on the native engine.
 *
 * The adapter-era integration wrapped the adapter's execute path, so file
 * writes made by MCP servers (e.g. a filesystem server) were recorded as
 * `file_observation` work records. Native MCP registers `mcp__<server>__<tool>`
 * tools we never see the execute path of, so observation hooks pi's events
 * instead: the `tool_call` handler (awaited before execution) takes the
 * "before" snapshot, and the `tool_result` handler records the diff. Nested
 * calls (a codemode script calling an MCP tool, `parentToolCallId` set) fire
 * the same events through `ctx.executeTool`, so they are observed too —
 * attributed to the parent call's request.
 *
 * Handlers never throw: a failing observation must not block an MCP call.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isResourceEnabled } from "../../resources/store.js"
import { debugWorkAttribution } from "../work-attribution/diagnostics.js"
import {
	beginToolFileObservation,
	endToolFileObservation,
	type ToolFileObservation,
} from "../work-attribution/file-observations.js"
import { COST_PER_PR_RESOURCE_ID } from "../work-attribution/resource.js"
import { getToolRequest, pinWorkContext } from "../work-attribution.js"

/** Dangling-observation cap: tool_result always fires, this is only a backstop. */
const MAX_PENDING = 32

export default function mcpWorkObservationExtension(pi: ExtensionAPI): void {
	if (!isResourceEnabled(COST_PER_PR_RESOURCE_ID)) return
	const pending = new Map<string, Promise<ToolFileObservation | undefined>>()

	pi.on("tool_call", async (event, ctx: ExtensionContext) => {
		if (!event.toolName.startsWith("mcp__")) return
		try {
			const pinned = pinWorkContext(ctx)
			// Top-level MCP calls are attributed to their own request; nested calls
			// (codemode scripts) fall back to the parent call's attribution.
			const identity =
				getToolRequest(pinned, event.toolCallId) ??
				(event.parentToolCallId !== undefined ? getToolRequest(pinned, event.parentToolCallId) : undefined)
			if (identity === undefined) return
			if (pending.size >= MAX_PENDING) {
				const oldest = pending.keys().next().value
				if (oldest !== undefined) pending.delete(oldest)
			}
			// pi awaits tool_call handlers before the tool executes, so awaiting
			// the begin here guarantees the "before" snapshot precedes the tool's
			// writes (same cost profile as the adapter-era inline wrap).
			const observation = await beginToolFileObservation(ctx, event.toolCallId, "mcp", identity)
			if (observation !== undefined) pending.set(event.toolCallId, Promise.resolve(observation))
		} catch (error) {
			debugWorkAttribution("MCP work observation begin failed:", error)
		}
	})

	pi.on("tool_result", async (event) => {
		const observation = pending.get(event.toolCallId)
		if (observation === undefined) return
		pending.delete(event.toolCallId)
		try {
			const resolved = await observation
			if (resolved !== undefined) await endToolFileObservation(resolved)
		} catch (error) {
			debugWorkAttribution("MCP work observation end failed:", error)
		}
	})
}
