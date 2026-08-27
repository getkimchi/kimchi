/**
 * Shared lifecycle wrapper for spawning foreground remote agents.
 *
 * Extracted from the `/remote-run` command handler so that both `/remote-run`
 * and the plan-approval paths ("Start execution in cloud") can reuse the same
 * logic: Ctrl+X kill handler, `spawnRemoteAgent` call, success/error
 * notification, and kill-handler cleanup.
 *
 * Named `runForegroundRemoteAgent` (not `runRemoteAgent`) to avoid collision
 * with the low-level `runRemoteAgent()` in `agents/manager/remote-agent-runner.ts`,
 * which manages the ACP session lifecycle.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui"
import { getActiveManager, type SpawnRemoteAgentOptions, spawnRemoteAgent } from "../agents/index.js"
import { getDisplayName } from "../agents/ui/agent-widget.js"
import { isRawInputCaptureActive } from "../shared-input.js"

/** Returns true when KIMCHI_REMOTE_RUN env var is truthy. */
export function isRemoteRunEnabled(): boolean {
	return !!process.env.KIMCHI_REMOTE_RUN
}

/**
 * Spawns a foreground remote agent with full lifecycle management:
 *
 * 1. Registers a Ctrl+X handler to kill the agent during startup or execution
 * 2. Calls `spawnRemoteAgent()` (foreground, blocks until agent settles)
 * 3. Notifies the user with a preview of the result on success
 * 4. Notifies the user with the error message on failure
 * 5. Cleans up the Ctrl+X handler in all cases
 *
 * Returns the full result text (for callers that want to inject it into
 * context) or throws on error.
 */
export async function runForegroundRemoteAgent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	prompt: string,
	description: string,
	opts?: SpawnRemoteAgentOptions,
): Promise<{ id: string; result: string; transcriptPath?: string }> {
	// Per-invocation agent id — set via onSpawn before the promise resolves.
	// Kept in the closure so concurrent invocations (e.g. after a Ctrl+B
	// detach) cannot overwrite each other's state.
	let agentId: string | undefined

	const killUnsub = ctx.ui.onTerminalInput((data) => {
		if (isRawInputCaptureActive()) return undefined
		if (!matchesKey(data, Key.ctrl("x")) || isKeyRelease(data)) return undefined
		if (!agentId) return undefined

		const manager = getActiveManager()
		const target = manager?.getRecord(agentId)
		if (!target || !manager) return undefined
		if (target.status !== "running" && target.status !== "error") return undefined

		manager.abort(agentId)
		ctx.ui.notify(`Stopped ${getDisplayName(target.type)} agent`, "info")
		return { consume: true }
	})

	try {
		const { result } = await spawnRemoteAgent(pi, ctx, prompt, description, opts)

		const preview = result.length > 500 ? `${result.slice(0, 500)}...` : result
		const record = getActiveManager()?.getRecord(agentId ?? "")
		const transcriptPath = record?.outputFile
		const transcriptNote = transcriptPath ? `\nFull transcript: ${transcriptPath}` : ""
		ctx.ui.notify(`${preview || "Remote agent completed with no output."}${transcriptNote}`, "info")
		if (transcriptPath) console.error(`[remote-run] transcript: ${transcriptPath}`)
		return { id: agentId ?? "", result, transcriptPath }
	} catch (err) {
		ctx.ui.notify(`Remote run failed: ${err instanceof Error ? err.message : String(err)}`, "error")
		throw err
	} finally {
		killUnsub()
	}
}
