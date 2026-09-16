/**
 * `dispatch_to_cloud_agent` tool — dispatches a self-contained task briefing
 * to a remote cloud agent via `runCloudAgent`.
 *
 * Registered only when KIMCHI_REMOTE_RUN is set and the session was not
 * launched with `--print` (the remote-run extension skips registration in
 * headless runs — no human exists to answer the consent dialog, and
 * remote dispatch is a supervised, user-led convenience, not something an
 * unsupervised agent should trigger on its own). The
 * execute-time `no_ui` refusal below stays as defense-in-depth for UI-less
 * sessions under interactive launches (e.g. subagent workers). The tool is part of the default tool set; plan
 * mode and ferment profiles swap it out via the tool catalog, so it is only
 * callable when direct dispatch is valid.
 *
 * Consent is structural and lives HERE, in the tool: the model may recognize
 * dispatch intent from any phrasing (or from injected content), but every
 * call — regardless of how it originated — waits on a user confirmation
 * dialog showing the actual briefing before a spawn happens. There is no
 * execution path that skips the human.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { withWorkingHidden } from "../ferment/prompt-ui.js"
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
		label: "Dispatch to remote agent",
		description:
			"Dispatch a fully self-contained task to a remote agent running on a remote sandbox. Use this when the user asks to run, delegate, or implement something remotely — e.g. 'continue in remote session', 'using the remote agent', 'do this in the remote session / on a sandbox'. IMPORTANT: before calling this tool, present the complete briefing verbatim in your message text so the user can read it in the chat; then call this tool with exactly that text as `task`. The briefing must be fully self-contained: the remote agent sees ONLY the task text plus the repository, never this conversation. Every call shows the user a confirmation dialog before anything is sent — do not call speculatively, and if the user declines, do not call again unless they explicitly re-ask. The remote agent runs in the background; the user is notified on completion.",
		promptSnippet: "Dispatch a self-contained task to a remote agent",
		parameters: DispatchToCloudAgentSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// Defense in depth: schema validation should guarantee a string, but
			// malformed model calls can bypass it — don't throw a raw TypeError.
			if (typeof params.task !== "string" || !params.task.trim()) {
				return {
					content: [{ type: "text" as const, text: "The `task` briefing must not be empty." }],
					details: { error: "empty_task" },
				}
			}
			const task = params.task.trim()
			// Aborted before we get to run (e.g. turn cancelled while the tool
			// was queued): don't launch remote compute the user just killed.
			if (signal?.aborted) {
				return {
					content: [{ type: "text" as const, text: "Dispatch cancelled." }],
					details: { error: "cancelled" },
				}
			}
			// Consent requires a dialog; without a UI there is no safe path.
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Cannot dispatch: this session has no interactive UI to confirm with. Tell the user to re-run interactively or use the /remote-run command.",
						},
					],
					details: { error: "no_ui" },
				}
			}
			// Mid-turn confirm: hide the working animation so it doesn't render
			// behind the dialog (same wrapper the other in-turn prompts use).
			// Pure decision dialog — no briefing content. The model presents the
			// full briefing in chat before calling (see description), and the
			// transcript is the only sane reading surface; recapping here would
			// be neither readable nor a meaningful integrity check.
			const confirmed = await withWorkingHidden(ctx.ui, () =>
				ctx.ui.confirm(
					"Dispatch to remote agent?",
					"A self-contained task brief will be sent to the remote agent. Conversation history is not transferred. Your local changes will be synced to the sandbox.",
				),
			)
			if (!confirmed) {
				return {
					content: [
						{
							type: "text" as const,
							text: "The user declined the remote dispatch. Do NOT retry dispatch_to_cloud_agent unless the user explicitly re-asks. Ask how to proceed — e.g. continue locally, or adjust the task.",
						},
					],
					details: { error: "declined" },
				}
			}
			const providedDescription = typeof params.description === "string" ? params.description.trim() : undefined
			const description =
				providedDescription ||
				`remote session: ${task.slice(0, DESCRIPTION_MAX)}${task.length > DESCRIPTION_MAX ? "..." : ""}`
			try {
				const { id } = await runCloudAgent(pi, ctx, task, description, {
					background: true,
					origin: DISPATCH_TO_CLOUD_AGENT_TOOL,
				})
				return {
					content: [
						{
							type: "text" as const,
							text: `Remote agent dispatched (agent ${id}). It is running in the background on a remote sandbox; the user will be notified when it completes. Do not redo this work locally.`,
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
							text: `Could not dispatch the remote agent: ${message}. Report the failure to the user and suggest retrying or running the task locally instead.`,
						},
					],
					details: { error: message },
				}
			}
		},
	})
}
