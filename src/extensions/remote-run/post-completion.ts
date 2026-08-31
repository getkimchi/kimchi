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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { loadConfig } from "../../config.js"
import { authenticateWorkspace } from "../../sandbox/cloud/auth.js"
import { withWorkingHidden } from "../ferment/prompt-ui.js"
import { withBlocked } from "../herdr-events.js"
import { markHarnessSteer } from "../steer-marker.js"
import { SANDBOX_USER } from "../teleport/provisioning/constants.js"
import { DIFF_RSYNC_EXCLUDES } from "../teleport/provisioning/sync-local-changes.js"
import { runRsync } from "../teleport/provisioning/rsync-runner.js"
import { basename } from "node:path"

const REVIEW = "Review the result and continue locally"
const SYNC = "Sync remote changes"
const CUSTOM = "Type your own action"
const DONE = "Done"

/** Remote session metadata passed from _runRemote for connection reuse in sync. */
export interface RemoteSessionMeta {
	workspaceId: string
	sessionName: string
	wsUrl: string
	host: string
	cwd: string
}

/** Options for handleRemoteCompletion. */
export interface HandleRemoteCompletionOpts {
	transcriptPath?: string
	agentId?: string
	/** Remote session metadata — when present, sync reuses the connection directly. */
	remoteSession?: RemoteSessionMeta
}

/**
 * Shows a post-completion dropdown after the remote cloud agent finishes.
 * Handles the user's choice: inject result, sync changes, or do nothing.
 *
 * The remote agent's result and transcript path are ALWAYS injected into the
 * local agent's context via a steer message — even when the user picks "Sync"
 * or "Done" — so the agent always knows where to find the full transcript.
 *
 * @param pi - Extension API
 * @param ctx - Extension context
 * @param result - The remote agent's result text
 * @param promptPrefix - Prefix for the injected steer message (e.g. "plan" or "ferment plan")
 */
export async function handleRemoteCompletion(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	result: string,
	promptPrefix: string,
	opts?: HandleRemoteCompletionOpts,
): Promise<void> {
	if (!ctx.hasUI) {
		injectRemoteResult(pi, result, promptPrefix, opts)
		return
	}

	const choice = await withBlocked(pi.events, "Remote execution complete", () =>
		withWorkingHidden(ctx.ui, () =>
			ctx.ui.select("Remote cloud agent finished. What would you like to do next?", [REVIEW, SYNC, CUSTOM, DONE]),
		),
	)

	// No selection (escape/dismiss) → treat as Done
	if (!choice) return

	switch (choice) {
		case DONE: {
			return
		}
		case SYNC: {
			await syncRemoteChanges(ctx, opts?.remoteSession)
			injectRemoteResult(pi, result, promptPrefix, opts, {
				actionSuffix:
					"\n\n---\n\nThe user synced the remote changes to their local working tree. Review the synced files if needed.",
			})
			return
		}
		case CUSTOM: {
			const actionText = await promptForCustomAction(ctx)
			if (!actionText) return // user cancelled input
			injectRemoteResult(pi, result, promptPrefix, opts, {
				actionSuffix: `\n\n---\n\nThe user wants you to: ${actionText}`,
			})
			return
		}
		case REVIEW: {
			injectRemoteResult(pi, result, promptPrefix, opts)
			return
		}
	}
}

/**
 * Injects the remote agent's result into the local session as a steer message.
 * The transcript path and agent ID are always included when available so the
 * local agent can locate the full transcript for follow-up questions.
 */
function injectRemoteResult(
	pi: ExtensionAPI,
	result: string,
	promptPrefix: string,
	opts?: HandleRemoteCompletionOpts,
	extra?: { actionSuffix?: string },
): void {
	const transcriptInfo = opts?.transcriptPath
		? `\n\nFull transcript of the remote agent's run (tool calls, outputs, text): ${opts.transcriptPath}`
		: ""
	const agentInfo = opts?.agentId
		? `\nAgent ID: ${opts.agentId} (use get_subagent_result with this ID for structured access to the agent's output)`
		: ""
	const actionSuffix = extra?.actionSuffix ?? ""

	const steer = `The approved ${promptPrefix} was executed by a remote cloud agent on a Linux sandbox. The plan has ALREADY been executed — do not re-plan or re-execute it. The code changes made by the remote agent are NOT in your local working tree unless the user synced them. Here is the remote agent's result:\n\n---\n\n${result}${transcriptInfo}${agentInfo}${actionSuffix}`

	pi.sendMessage(
		{
			customType: "remote_plan_result",
			content: markHarnessSteer(steer),
			display: false,
		},
		{ triggerTurn: true },
	)
}

/**
 * Syncs changes from the remote sandbox back to the local working directory.
 *
 * Reuses the connection metadata (workspaceId, host, cwd) from the original
 * remote run — no workspace listing, no re-authentication, no basename
 * guessing. The remoteSession metadata is always set by _runRemote in the
 * normal flow.
 *
 * The downward rsync always excludes `.git/`, secrets, and harness state
 * (`DIFF_RSYNC_EXCLUDES`) so the local repository is never corrupted or
 * polluted with internal files.
 */
async function syncRemoteChanges(ctx: ExtensionContext, remoteSession?: RemoteSessionMeta): Promise<void> {
	try {
		if (!remoteSession) {
			ctx.ui.notify(
				"Cannot sync: remote session metadata is missing. The remote run may have failed before recording connection details.",
				"error",
			)
			return
		}

		const apiKey = loadConfig().apiKey
		if (!apiKey) {
			ctx.ui.notify("No API key configured. Run `kimchi login`.", "error")
			return
		}

		// The session was deleted after the run, but the workspace is still
		// alive — re-authenticate to get a fresh token for the same workspace.
		const creds = await authenticateWorkspace(
			remoteSession.workspaceId,
			apiKey,
			basename(ctx.cwd) || "kimchi",
			{ endpoint: process.env.KIMCHI_REMOTE_ENDPOINT },
		)

		// Trailing slash on the source ("down" direction) is critical: without it,
		// rsync creates a nested directory (ctx.cwd/kimchi/) instead of syncing
		// the contents into ctx.cwd directly.
		const remotePath = remoteSession.cwd.endsWith("/") ? remoteSession.cwd : `${remoteSession.cwd}/`

		ctx.ui.notify("Syncing changes from remote sandbox…", "info")

		const rsyncResult = await runRsync({
			localPath: ctx.cwd,
			remotePath,
			direction: "down",
			isSourceDirectory: true,
			remoteHost: creds.host,
			remoteUser: SANDBOX_USER,
			authToken: creds.connectToken,
			excludeFilters: [...DIFF_RSYNC_EXCLUDES],
			deleteExtraneous: false,
			signal: undefined,
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
