/**
 * Shared lifecycle wrapper for spawning remote cloud agents.
 *
 * Named `runCloudAgent` (not `runRemoteAgent`) to avoid collision
 * with the low-level `runRemoteAgent()` in `agents/manager/remote-agent-runner.ts`,
 * which manages the ACP session lifecycle.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import {
	buildRemoteExecutionStats,
	getActiveManager,
	type SpawnRemoteAgentOptions,
	spawnRemoteAgent,
} from "../agents/index.js"
import { trackRemoteExecution } from "../telemetry/index.js"

/** Max characters for the result preview in the completion notification. */
const PREVIEW_MAX = 500

/** Returns true when KIMCHI_REMOTE_RUN env var is set. */
export function isRemoteRunEnabled(): boolean {
	return !!process.env.KIMCHI_REMOTE_RUN
}

/**
 * Spawns a remote cloud agent as a background agent.
 *
 * The agent runs on a remote sandbox via ACP. The function returns immediately
 * with the agent ID. `handleRemoteCompletion` fires automatically when the agent
 * finishes (showing the Review / Sync / Done dropdown and injecting the result
 * into the local agent's context).
 *
 * Ctrl+X kill is handled by the agents extension's own terminal-input handler
 * (targets the most recently spawned running background agent).
 */
export async function runCloudAgent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	prompt: string,
	description: string,
	opts?: SpawnRemoteAgentOptions,
): Promise<{ id: string; result: string; transcriptPath?: string; backgrounded?: boolean }> {
	const { id, result, backgrounded } = await spawnRemoteAgent(pi, ctx, prompt, description, opts)
	trackRemoteExecution("started", opts?.origin ?? "plan")

	if (backgrounded) {
		ctx.ui.notify("Cloud agent started in background. You'll be notified when it completes.", "info")
		if (opts?.fermentId) {
			ctx.ui.notify(
				"Ferment paused while the cloud agent executes the plan. It will resume or complete when the cloud agent finishes.",
				"info",
			)
		}
		pi.sendMessage(
			{
				customType: "cloud_agent_started",
				content: `A cloud agent has been started in the background to execute the plan. It is running on a remote sandbox. You will be notified when it completes —${
					opts?.fermentId
						? " do not re-plan, re-execute, create todos, or call activate_ferment_phase. The ferment is paused while the cloud agent works."
						: " do not re-plan or re-execute."
				} Wait for the completion notification. The agent ID is ${id}.`,
				display: false,
			},
			{ triggerTurn: true },
		)
		return { id, result, backgrounded: true }
	}

	// Foreground (non-detached) completion — background agents emit
	// completed/failed from the manager's onComplete callback instead.
	const preview = result.length > PREVIEW_MAX ? `${result.slice(0, PREVIEW_MAX)}...` : result
	const record = getActiveManager()?.getRecord(id)
	trackRemoteExecution(
		record?.status === "error" ? "failed" : "completed",
		opts?.origin ?? "plan",
		record ? buildRemoteExecutionStats(record) : undefined,
	)
	const transcriptPath = record?.outputFile
	const transcriptNote = transcriptPath ? `\nFull transcript: ${transcriptPath}` : ""
	ctx.ui.notify(`${preview || "Remote agent completed with no output."}${transcriptNote}`, "info")
	return { id, result, transcriptPath }
}
