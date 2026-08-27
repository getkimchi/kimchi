/**
 * Post-completion handler for remote plan execution.
 *
 * After the remote cloud agent finishes, shows a dropdown asking the user
 * what to do next. Options:
 * - "Review the result and continue locally" — injects result + triggers turn
 * - "Sync remote changes" — rsyncs changed files from sandbox to local
 * - "Type your own action" — injects result + triggers turn with custom action
 * - "Done" — no further action
 */

import { basename } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { loadConfig } from "../../config.js"
import { authenticateWorkspace } from "../../sandbox/cloud/auth.js"
import { listWorkspaces } from "../../sandbox/cloud/workspaces.js"
import { withWorkingHidden } from "../ferment/prompt-ui.js"
import { withBlocked } from "../herdr-events.js"
import { markHarnessSteer } from "../steer-marker.js"
import { SANDBOX_USER } from "../teleport/provisioning/constants.js"
import { runRsync } from "../teleport/provisioning/rsync-runner.js"

const REVIEW = "Review the result and continue locally"
const SYNC = "Sync remote changes"
const CUSTOM = "Type your own action"
const DONE = "Done"

/**
 * Shows a post-completion dropdown after the remote cloud agent finishes.
 * Handles the user's choice: inject result, sync changes, or do nothing.
 */
export async function handleRemoteCompletion(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	result: string,
	promptPrefix: string,
	transcriptPath: string | undefined,
	agentId: string | undefined,
): Promise<void> {
	if (!ctx.hasUI) return

	const choice = await withBlocked(pi.events, "Remote execution complete", () =>
		withWorkingHidden(ctx.ui, () =>
			ctx.ui.select("Remote cloud agent finished. What would you like to do next?", [REVIEW, SYNC, CUSTOM, DONE]),
		),
	)

	if (!choice || choice === DONE) return

	if (choice === SYNC) {
		await syncRemoteChanges(ctx)
		return
	}

	const actionText = choice === CUSTOM ? await promptForCustomAction(ctx) : undefined
	if (choice === CUSTOM && !actionText) return

	const transcriptInfo = transcriptPath
		? `\n\nFull transcript of the remote agent's run (tool calls, outputs, text): ${transcriptPath}`
		: ""
	const agentInfo = agentId
		? `\nAgent ID: ${agentId} (use get_subagent_result with this ID for structured access to the agent's output)`
		: ""
	const actionSuffix = actionText ? `\n\n---\n\nThe user wants you to: ${actionText}` : ""

	pi.sendMessage(
		{
			customType: "remote_plan_result",
			content: markHarnessSteer(
				`The remote cloud agent completed execution of the approved ${promptPrefix}. Here is its result:\n\n---\n\n${result}${transcriptInfo}${agentInfo}${actionSuffix}`,
			),
			display: false,
		},
		{ triggerTurn: true },
	)
}

/**
 * Syncs changes from the remote sandbox back to the local working directory.
 * Re-authenticates with the same workspace the remote agent used (matched by
 * repo basename, same convention as agent-manager._runRemote).
 */
async function syncRemoteChanges(ctx: ExtensionContext): Promise<void> {
	try {
		const apiKey = loadConfig().apiKey
		if (!apiKey) {
			ctx.ui.notify("No API key configured. Run `kimchi login`.", "error")
			return
		}

		const dirName = basename(ctx.cwd) || "kimchi"
		const workspaces = await listWorkspaces(apiKey, {
			endpoint: process.env.KIMCHI_REMOTE_ENDPOINT,
		})
		const workspace = workspaces.find((w) => w.name.toLowerCase() === dirName.toLowerCase())
		if (!workspace) {
			ctx.ui.notify(`No workspace found matching "${dirName}". Cannot sync.`, "error")
			return
		}

		const creds = await authenticateWorkspace(workspace.id, apiKey, dirName, {
			endpoint: process.env.KIMCHI_REMOTE_ENDPOINT,
		})

		const remotePath = `/home/sandbox/${dirName}/`

		ctx.ui.notify("Syncing changes from remote sandbox…", "info")

		const rsyncResult = await runRsync({
			localPath: ctx.cwd,
			remotePath,
			direction: "down",
			isSourceDirectory: true,
			remoteHost: creds.host,
			remoteUser: SANDBOX_USER,
			authToken: creds.connectToken,
			excludeGlobs: [".git/"],
			onPhase: () => {},
		})

		const kb = (rsyncResult.totalBytes / 1024).toFixed(0)
		const sec = (rsyncResult.durationMs / 1000).toFixed(1)
		ctx.ui.notify(`Sync complete: ${rsyncResult.fileCount} file(s), ${kb} KB in ${sec}s.`, "info")
	} catch (err) {
		ctx.ui.notify(`Sync failed: ${err instanceof Error ? err.message : String(err)}`, "error")
	}
}

async function promptForCustomAction(ctx: ExtensionContext): Promise<string | undefined> {
	const text = await withWorkingHidden(
		ctx.ui,
		() => ctx.ui.input?.("What would you like the agent to do next?") ?? Promise.resolve(undefined),
	)
	return text?.trim() || undefined
}
