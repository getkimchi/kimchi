/**
 * `dispatch_to_cloud_agent` tool — dispatches a self-contained task briefing
 * to a remote cloud agent via `runCloudAgent`.
 *
 * Registered only when KIMCHI_REMOTE_RUN is set (the remote-run extension
 * returns early otherwise). The tool is part of the default tool set; plan
 * mode and ferment profiles swap it out via the tool catalog, so it is only
 * callable when direct dispatch is valid.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { runCloudAgent } from "./runner.js"

export const DISPATCH_TO_CLOUD_AGENT_TOOL = "dispatch_to_cloud_agent"

const DESCRIPTION_MAX = 60

const DispatchToCloudAgentSchema = Type.Object({
	task: Type.String({
		description:
			"Fully self-contained task briefing for the remote agent: goal, all relevant context and findings from this conversation, file paths, constraints, and how to verify the result. The remote agent sees ONLY this text plus the repository — it has no access to this conversation.",
	}),
	description: Type.Optional(
		Type.String({
			description: "Short label for the run, shown in the agent list. Defaults to a prefix of the task.",
		}),
	),
})

export function registerDispatchToCloudAgentTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: DISPATCH_TO_CLOUD_AGENT_TOOL,
		label: "Dispatch to cloud agent",
		description:
			"Dispatch a fully self-contained task to a remote cloud agent running on a cloud sandbox. Only call this when the user explicitly asked to continue in a remote session / run the task in the cloud — the harness transforms such requests into rewrite instructions for you. The remote agent runs in the background; the user is notified on completion.",
		promptSnippet: "Dispatch a self-contained task to a remote cloud agent",
		parameters: DispatchToCloudAgentSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = params.task.trim()
			if (!task) {
				return {
					content: [{ type: "text" as const, text: "The `task` briefing must not be empty." }],
					details: { error: "empty_task" },
				}
			}
			const description =
				params.description?.trim() ||
				`remote session: ${task.slice(0, DESCRIPTION_MAX)}${task.length > DESCRIPTION_MAX ? "..." : ""}`
			try {
				const { id } = await runCloudAgent(pi, ctx, task, description, {
					background: true,
					origin: "remote session",
				})
				return {
					content: [
						{
							type: "text" as const,
							text: `Cloud agent dispatched (agent ${id}). It is running in the background on a remote sandbox; the user will be notified when it completes. Do not redo this work locally.`,
						},
					],
					details: { agentId: id },
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err)
				return {
					content: [
						{
							type: "text" as const,
							text: `Could not dispatch the cloud agent: ${message}. Report the failure to the user and suggest retrying or running the task locally instead.`,
						},
					],
					details: { error: message },
				}
			}
		},
	})
}
