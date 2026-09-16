/**
 * Post-completion handler for remote plan execution.
 *
 * After the remote agent finishes, shows a dropdown asking the user
 * what to do next. Options (in display order):
 * - "Pull the changes to my machine and finish" — rsyncs changed files from sandbox to local
 * - "Review the remote agent's results in the local session" — injects result + triggers turn
 * - "Describe what to do next" — injects result + triggers turn with custom action
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { loadConfig } from "../../config.js"
import { authenticateWorkspace } from "../../sandbox/cloud/auth.js"
import { deleteRemoteSession, type RemoteSessionMeta } from "../agents/manager/remote-agent-runner.js"
import type { PersistedGitWorkflow } from "../agents/remote-run-persistence.js"
import { withWorkingHidden } from "../ferment/prompt-ui.js"
import { defaultFermentRuntime } from "../ferment/runtime.js"
import { createApplyAndPersist } from "../ferment/tool-helpers.js"
import { withBlocked } from "../herdr-events.js"
import { markHarnessSteer } from "../steer-marker.js"
import { trackRemoteExecution } from "../telemetry/index.js"
import { SANDBOX_USER } from "../teleport/provisioning/constants.js"
import { runRsync } from "../teleport/provisioning/rsync-runner.js"
import { DIFF_RSYNC_EXCLUDES } from "../teleport/provisioning/sync-local-changes.js"
import { DIFF_MESSAGE_CAP_LINES, REMOTE_DIFF_ENTRY_TYPE, type RemoteRunDiffDetails } from "./diff-entry.js"
import {
	createDraftPr,
	type PushResult,
	pullBranchLocally,
	pushBranchRemotely,
	pushViaLocalFallback,
	scanDiffForSecrets,
} from "./push-and-pr.js"
import {
	type CompletionDiffStat,
	collectCompletionDiff,
	type RemotePatchStream,
	streamRemotePatch,
} from "./remote-diff.js"
import { continueCloudAgent } from "./runner.js"
import { recoverBaseShaFromMergeBase, resolveSandboxGitConnection, type SandboxGitConnection } from "./sandbox-git.js"
import { buildDiffHtmlDocument } from "./ui/diff-html.js"
import { DiffViewer } from "./ui/diff-viewer.js"
import { openExternalDiff, openInBrowser } from "./ui/external-viewer.js"
import { type ReviewComment, type ReviewDecision, type ReviewServer, startReviewServer } from "./ui/review-server.js"

const REVIEW = "Review the remote agent's results in the local session"
const SYNC = "Pull the changes to my machine and finish"
const CUSTOM = "Describe what to do next"
const SHOW_DIFF = "Show the diff"
const SHOW_DIFF_BROWSER = "Review the diff in browser (comment & decide)"
const SHOW_DIFF_EXTERNAL = "Show diff in external viewer"

/** Plannotator shared event bus action for its browser code-review UI. */
const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request"
const REQUEST_CHANGES = "Request changes (steer the remote agent)"
const PUSH_AND_PR = "Push branch and open draft PR"
const PUSH_AND_PULL = "Push branch and pull locally"
const PUSH_LOCAL_FALLBACK = "Push with my local credentials instead"
const DONE_KEEP_SESSION = "Done (keep the remote session for later)"

/** Options for handleRemoteCompletion. */
export interface HandleRemoteCompletionOpts {
	transcriptPath?: string
	agentId?: string
	/** Remote session metadata — when present, sync reuses the connection directly. */
	remoteSession?: RemoteSessionMeta
	/** Ferment ID when the remote agent executed a ferment plan. The ferment is
	 *  paused during remote execution; on completion it is completed (sync) or
	 *  resumed (review/custom), or stays paused on dismiss, so the user can
	 *  continue locally. */
	fermentId?: string
	/** Git intent + captured baseline for PR-first runs — switches the
	 *  completion dropdown to review/steer/push entries. */
	gitWorkflow?: PersistedGitWorkflow
	/** Persisted ACP session id — required to steer the kept-alive session. */
	acpSessionId?: string
	/** Recovery note when the result was recovered after a network disconnect. */
	recoveryNote?: string
}

/**
 * Shows a post-completion dropdown after the remote agent finishes.
 * Handles the user's choice: inject result, sync changes, or collect a custom action.
 *
 * The remote agent's result and transcript path are ALWAYS injected into the
 * local agent's context via a steer message — even when the user picks the
 * download option — so the agent always knows where to find the full transcript.
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

	// PR-first runs (dispatched with a branch intent + captured baseline):
	// review-first dropdown fed by diff stats collected over SSH on the
	// sandbox — the local repo is never touched. handlePrCompletion returns
	// false when review collection is impossible or meaningless; the flow
	// then degrades honestly into the standard menu below.
	if (opts?.gitWorkflow && opts.remoteSession) {
		const handled = await handlePrCompletion(pi, ctx, result, promptPrefix, {
			...opts,
			gitWorkflow: opts.gitWorkflow,
			remoteSession: opts.remoteSession,
		})
		if (handled) return
	}

	const choice = await withBlocked(pi.events, "Remote execution complete", () =>
		withWorkingHidden(ctx.ui, () =>
			ctx.ui.select("Remote agent run finished. What would you like to do next?", [SYNC, REVIEW, CUSTOM]),
		),
	)

	// No selection (escape/dismiss) → no-op; a paused ferment stays paused
	if (!choice) return

	switch (choice) {
		case SYNC: {
			trackRemoteExecution("sync.started", promptPrefix)
			const synced = await syncRemoteChanges(ctx, opts?.remoteSession)
			trackRemoteExecution(synced ? "sync.completed" : "sync.failed", promptPrefix)
			completeFerment(opts?.fermentId)
			injectRemoteResult(pi, result, promptPrefix, opts, {
				actionSuffix:
					"\n\n---\n\nThe user synced the remote changes to their local working tree. Review the synced files if needed.",
			})
			return
		}
		case CUSTOM: {
			const actionText = await promptForCustomAction(ctx)
			if (!actionText) return // user cancelled input
			trackRemoteExecution("custom_action", promptPrefix)
			await confirmResumeFerment(ctx, opts?.fermentId)
			injectRemoteResult(pi, result, promptPrefix, opts, {
				actionSuffix: `\n\n---\n\nThe user wants you to: ${actionText}`,
			})
			return
		}
		case REVIEW: {
			trackRemoteExecution("viewed", promptPrefix)
			injectRemoteResult(pi, result, promptPrefix, opts)
			await confirmResumeFerment(ctx, opts?.fermentId)
			return
		}
	}
}

/** Options for handleRemoteFailure. */
export interface HandleRemoteFailureOpts {
	/** Why the run failed — surfaced in the error notification / steer message. */
	error?: string
	/** Recovery note when the run's result could not be recovered after a disconnect. */
	recoveryNote?: string
	/** True when the run was stopped by the user (Escape / Ctrl+X) rather
	 *  than failing on its own — softens the steer wording and skips the
	 *  interactive notification (the kill handler already announced the stop). */
	stoppedByUser?: boolean
	/** Ferment ID when the remote agent executed a ferment plan. The ferment is
	 *  resumed (un-paused) so the user can continue locally. */
	fermentId?: string
}

/**
 * Handles a FAILED remote agent run — the counterpart of
 * handleRemoteCompletion for errored/aborted runs.
 *
 * There is no result to review or sync, so no completion dropdown is shown:
 * - The ferment paused for remote execution (if any) is resumed — a failed
 *   remote run must not leave it paused forever.
 * - Interactive sessions get an error notification.
 * - Headless sessions get a steer message instead (a notification would be
 *   invisible there): the local agent is still waiting on the completion
 *   notification promised when the remote agent was spawned.
 */
export function handleRemoteFailure(
	pi: ExtensionAPI,
	ctx: ExtensionContext | undefined,
	promptPrefix: string,
	opts?: HandleRemoteFailureOpts,
): void {
	resumeFerment(opts?.fermentId)
	if (!ctx) return
	const detail = opts?.error?.trim() || "unknown error"
	if (ctx.hasUI) {
		// A user-initiated stop was already announced by the kill handler
		// ("Stopped … agent") — don't pile a failure notification on top.
		if (!opts?.stoppedByUser) {
			// Include the recovery note's reason (first sentence) — without it, a
			// failed resume ("result could not be recovered") is undiagnosable
			// from the UI alone.
			const reason = opts?.recoveryNote?.split(". ")[0]
			ctx.ui.notify(`Remote agent failed: ${detail}${reason ? ` — ${reason}` : ""}`, "error")
		}
		return
	}
	const recoveryNote = opts?.recoveryNote ? `\n\n${opts.recoveryNote}` : ""
	const lead = opts?.stoppedByUser
		? `The remote agent was stopped by the user before finishing the approved ${promptPrefix}.`
		: `The remote agent FAILED while executing the approved ${promptPrefix}.`
	const errorLine = opts?.stoppedByUser ? "" : `\n\nError: ${detail}`
	const steer = `${lead} The ${promptPrefix} was NOT completed — do not assume any changes were made or that a result is available.${recoveryNote}${errorLine}\n\nAsk the user how to proceed: execute the ${promptPrefix} locally, re-dispatch it to a remote workspace, or abandon it.`
	pi.sendMessage(
		{
			customType: "remote_plan_failed",
			content: markHarnessSteer(steer),
			display: false,
		},
		{ triggerTurn: true },
	)
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
	const recoveryNote = opts?.recoveryNote ? `\n\n${opts.recoveryNote}` : ""
	const actionSuffix = extra?.actionSuffix ?? ""

	const steer = `The approved ${promptPrefix} was executed by a remote agent on a Linux sandbox. The plan has ALREADY been executed — do not re-plan or re-execute it. The code changes made by the remote agent are NOT in your local working tree unless the user synced them. Here is the remote agent's result:\n\n---\n\n${result}${transcriptInfo}${agentInfo}${recoveryNote}${actionSuffix}`

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
/**
 * @returns true when the sync completed successfully, false otherwise.
 */
async function syncRemoteChanges(ctx: ExtensionContext, remoteSession?: RemoteSessionMeta): Promise<boolean> {
	try {
		if (!remoteSession) {
			ctx.ui.notify(
				"Cannot sync: remote session metadata is missing. The remote run may have failed before recording connection details.",
				"error",
			)
			return false
		}

		const apiKey = loadConfig().apiKey
		if (!apiKey) {
			ctx.ui.notify("No API key configured. Run `kimchi login`.", "error")
			return false
		}

		// The session was deleted after the run, but the workspace is still
		// alive — re-authenticate to get a fresh token for the same workspace.
		const creds = await authenticateWorkspace(remoteSession.workspaceId, apiKey, basename(ctx.cwd) || "kimchi", {
			endpoint: process.env.KIMCHI_REMOTE_ENDPOINT,
		})

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
		return true
	} catch (err) {
		ctx.ui.notify(`Sync failed: ${err instanceof Error ? err.message : String(err)}`, "error")
		return false
	}
}

/**
 * Completes the ferment after a successful remote execution + sync.
 * The ferment was paused when the remote agent was spawned; syncing means
 * the user accepted the remote work, so we mark the ferment as complete.
 *
 * The ferment was never locally activated (no phase ran locally) — the remote
 * agent handled everything. So we resume (un-pause), skip all non-terminal
 * phases (they were executed remotely), then complete the ferment.
 */
function completeFerment(fermentId?: string): void {
	if (!fermentId) return
	const applyAndPersist = createApplyAndPersist(defaultFermentRuntime)
	// Resume first — complete_ferment is blocked while paused.
	const resumeOutcome = applyAndPersist(fermentId, { type: "resume" })
	if (!resumeOutcome.ok) return
	let ferment = resumeOutcome.ferment
	// Skip all non-terminal phases — they were executed in the remote sandbox.
	for (const phase of ferment.phases) {
		if (!["completed", "skipped", "failed"].includes(phase.status)) {
			const skipOutcome = applyAndPersist(fermentId, {
				type: "skip_phase",
				phaseId: phase.id,
				reason: "Executed in cloud sandbox",
			})
			if (skipOutcome.ok) ferment = skipOutcome.ferment
		}
	}
	// Now complete the ferment — all phases are terminal.
	const completeOutcome = applyAndPersist(fermentId, {
		type: "complete_ferment",
		finalSummary: "Executed in cloud sandbox",
	})
	if (completeOutcome.ok) {
		defaultFermentRuntime.setActive(completeOutcome.ferment)
	} else {
		// Fall back to the resumed/skipped state if complete failed.
		defaultFermentRuntime.setActive(ferment)
	}
}

/**
 * Resumes the ferment so the user can continue locally after the remote agent
 * finishes. Called for Review and Custom choices — the remote agent's
 * work is available in the transcript, but the ferment stays open for local
 * follow-up.
 */
function resumeFerment(fermentId?: string): void {
	if (!fermentId) return
	const applyAndPersist = createApplyAndPersist(defaultFermentRuntime)
	const outcome = applyAndPersist(fermentId, { type: "resume" })
	if (outcome.ok) {
		defaultFermentRuntime.setActive(outcome.ferment)
	}
}

/**
 * Asks the user whether to resume the paused ferment. Only resumes if the user
 * confirms — the ferment stays paused otherwise so the user can resume later
 * via /ferment resume.
 */
async function confirmResumeFerment(ctx: ExtensionContext, fermentId?: string): Promise<void> {
	if (!fermentId) return
	const confirmed = await withWorkingHidden(ctx.ui, () =>
		ctx.ui.confirm("Resume ferment?", "The ferment is paused. Resume it now to continue locally?"),
	)
	if (confirmed) {
		resumeFerment(fermentId)
	}
}

async function promptForCustomAction(ctx: ExtensionContext): Promise<string | undefined> {
	const text = await withWorkingHidden(
		ctx.ui,
		() => ctx.ui.input?.("What would you like the agent to do next?") ?? Promise.resolve(undefined),
	)
	return text?.trim() || undefined
}

function errMessage(err: unknown): string {
	// Node abort errors read "The operation was aborted" — useless. Name the
	// cause (a fetch/ssh timeout), which is what abort means in our paths.
	if (err instanceof Error && err.name === "AbortError") {
		return "connection timed out"
	}
	return err instanceof Error ? err.message : String(err)
}

function previewList(paths: string[]): string {
	const shown = paths.slice(0, 3)
	const rest = paths.length - shown.length
	return shown.join(", ") + (rest > 0 ? ` (+${rest} more)` : "")
}

/**
 * PR-first completion flow: review-first dropdown fed by diff stats
 * collected over SSH on the sandbox — the local repository is never
 * touched. Returns false when review collection is impossible (no API key,
 * no baseline, SSH failure) or meaningless (no commits), so the caller
 * degrades into the standard completion menu with an honest notification.
 *
 * The ferment (if any) stays paused through the whole review loop — it is
 * completed only by the sync choice (existing semantics). Dismissal or
 * "Done" leaves the remote session + branch alive for later steering.
 */
async function handlePrCompletion(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	result: string,
	promptPrefix: string,
	opts: HandleRemoteCompletionOpts & { gitWorkflow: PersistedGitWorkflow; remoteSession: RemoteSessionMeta },
): Promise<boolean> {
	const git = opts.gitWorkflow
	const apiKey = loadConfig().apiKey
	if (!apiKey) {
		ctx.ui.notify("No API key configured. Run `kimchi login`.", "error")
		return false
	}

	// No pre-run baseline (its capture failed at dispatch — user already got
	// a warning): re-capturing now would anchor the range at a post-commit
	// HEAD (silently poisoning the diff). Recover instead via the fork point
	// of the base branch, when one was recorded.
	let baseSha = git.baseSha
	if (!baseSha) {
		if (git.baseBranch) {
			const conn0 = await resolveSandboxGitConnection(opts.remoteSession, apiKey, {
				endpoint: process.env.KIMCHI_REMOTE_ENDPOINT,
			}).catch(() => undefined)
			if (conn0) {
				baseSha = await recoverBaseShaFromMergeBase(conn0, git.baseBranch).catch(() => undefined)
			}
		}
		if (!baseSha) {
			ctx.ui.notify(
				`The remote branch ${git.branch} is ready, but no review baseline could be determined (no pre-run baseline${git.baseBranch ? `, and no merge-base with ${git.baseBranch}` : ""}) — cannot compute the review diff. Falling back to the standard actions.`,
				"warning",
			)
			return false
		}
		ctx.ui.notify(
			`Review baseline recovered via merge-base with ${git.baseBranch} (the pre-run baseline was never captured).`,
			"info",
		)
	}

	let connection: SandboxGitConnection
	let stat: CompletionDiffStat | undefined
	const baseShaConst = baseSha
	try {
		// One retry: the credential-exchange fetch (30s timeout) is the flaky
		// hop in practice — it aborts silently when the control endpoint
		// stalls, with no bearing on whether the sandbox itself is alive.
		const collect = async (): Promise<[SandboxGitConnection, CompletionDiffStat | undefined]> => {
			const conn = await resolveSandboxGitConnection(opts.remoteSession, apiKey, {
				endpoint: process.env.KIMCHI_REMOTE_ENDPOINT,
			})
			const diffStat = await collectCompletionDiff({
				connection: conn,
				baseSha: baseShaConst,
				baselineDirtyFiles: git.dirtyFiles,
			})
			return [conn, diffStat]
		}
		let result: [SandboxGitConnection, CompletionDiffStat | undefined]
		try {
			result = await collect()
		} catch (firstErr) {
			ctx.ui.notify(`Diff collection stalled (${errMessage(firstErr)}) — retrying once…`, "info")
			result = await collect()
		}
		connection = result[0]
		stat = result[1]
	} catch (err) {
		ctx.ui.notify(
			`Could not collect the remote diff: ${errMessage(err)}. Falling back to the standard actions.`,
			"warning",
		)
		return false
	}
	if (!stat) {
		ctx.ui.notify(
			`The remote agent did not commit anything on ${git.branch} — there is no diff to review. Falling back to the standard actions.`,
			"info",
		)
		return false
	}

	const statText = `${stat.files} file${stat.files === 1 ? "" : "s"} changed, ${stat.additions} insertion${stat.additions === 1 ? "" : "s"}(+), ${stat.deletions} deletion${stat.deletions === 1 ? "" : "s"}(-)`
	const viewerTitle = `${git.branch} — ${stat.files} file${stat.files === 1 ? "" : "s"} (+${stat.additions}/-${stat.deletions})`
	const warnings: string[] = []
	if (stat.leftoverFiles.length > 0) {
		warnings.push(
			`⚠ ${stat.leftoverFiles.length} uncommitted file(s) left on the sandbox: ${previewList(stat.leftoverFiles)}`,
		)
	}
	if (stat.touchedBaselineFiles.length > 0) {
		warnings.push(
			`⚠ the run touched file(s) that were already dirty before it started: ${previewList(stat.touchedBaselineFiles)}`,
		)
	}

	let diffPersisted = false

	// Steer the kept-alive agent with new instructions. Terminal on success
	// (the dropdown closes and the agent runs); false when not steerable.
	const doRequestChanges = async (feedback: string): Promise<boolean> => {
		if (!opts.acpSessionId) {
			ctx.ui.notify(
				"Cannot steer: this run's ACP session id was not captured, so the kept session cannot be steered. The session stays alive — use the remote-sessions panel.",
				"error",
			)
			return false
		}
		// Background continuation: the dropdown closes NOW; on completion a
		// fresh handleRemoteCompletion (same gitWorkflow on the new record)
		// re-runs the diff collection and re-enters this PR menu.
		await continueCloudAgent(pi, ctx, feedback, {
			remoteSession: opts.remoteSession,
			acpSessionId: opts.acpSessionId,
			gitWorkflow: git,
			origin: promptPrefix,
			fermentId: opts.fermentId,
		})
		return true
	}

	// Consent-gated push + draft-PR terminal action.
	const doPushAndPr = async (): Promise<boolean> => {
		const pushed = await pushAndOpenDraftPr(pi, ctx, {
			connection,
			baseSha,
			git,
			result,
			opts,
			apiKey,
		})
		// Not terminal (declined / failed): back to the menu loop.
		if (!pushed) return false
		// Terminal: same cleanup + result injection as the sync exit.
		completeFerment(opts.fermentId)
		injectRemoteResult(pi, result, promptPrefix, opts, {
			actionSuffix:
				"\n\n---\n\nThe user pushed the remote branch and opened a draft PR. Review the PR when ready; no local sync was performed.",
		})
		return true
	}

	for (;;) {
		const menuTitle = [`Remote branch ${git.branch} is ready — ${statText}.`, ...warnings, "What next?"].join("\n")
		const choice = await withBlocked(pi.events, "Remote execution complete", () =>
			withWorkingHidden(ctx.ui, () =>
				ctx.ui.select(menuTitle, [
					SHOW_DIFF,
					SHOW_DIFF_BROWSER,
					SHOW_DIFF_EXTERNAL,
					REQUEST_CHANGES,
					PUSH_AND_PR,
					PUSH_AND_PULL,
					SYNC,
					DONE_KEEP_SESSION,
				]),
			),
		)
		// Dismissed: the branch and session stay alive, the ferment stays paused.
		if (!choice) return true
		if (choice === SHOW_DIFF) {
			diffPersisted = await showDiffOverlay(pi, ctx, {
				transcriptPath: opts.transcriptPath,
				baseSha,
				connection,
				viewerTitle,
				statText,
				diffPersisted,
			})
			continue
		}
		if (choice === SHOW_DIFF_BROWSER) {
			const reviewed = await runBrowserReview(ctx, {
				transcriptPath: opts.transcriptPath,
				baseSha,
				connection,
				branch: git.branch,
				viewerTitle,
				statText,
				diffPersisted,
			})
			if (!reviewed) continue // stream/server failure — notified inside
			diffPersisted = reviewed.persisted
			const { decision } = reviewed
			if (decision.kind === "closed") continue
			if (decision.kind === "approve") {
				ctx.ui.notify("Approved in the browser — moving to push & draft PR.", "info")
				if (await doPushAndPr()) return true
				continue
			}
			// request-changes: assemble the annotated prompt and steer.
			const steerText = formatReviewComments(decision.summary, decision.comments)
			if (!steerText) continue // empty review — nothing to steer on
			if (await doRequestChanges(steerText)) return true
			continue
		}
		if (choice === SHOW_DIFF_EXTERNAL) {
			diffPersisted = await showDiffExternally(ctx, {
				transcriptPath: opts.transcriptPath,
				baseSha,
				connection,
				branch: git.branch,
				diffPersisted,
			})
			continue
		}
		if (choice === REQUEST_CHANGES) {
			const feedback = await withWorkingHidden(
				ctx.ui,
				() => ctx.ui.input?.("What should the remote agent change?") ?? Promise.resolve(undefined),
			)
			if (!feedback?.trim()) continue
			if (await doRequestChanges(feedback.trim())) return true
			continue
		}
		if (choice === PUSH_AND_PR) {
			if (await doPushAndPr()) return true
			continue
		}
		if (choice === PUSH_AND_PULL) {
			const pulled = await pushAndPullLocally(pi, ctx, {
				connection,
				baseSha,
				git,
				result,
				opts,
				apiKey,
			})
			if (!pulled) continue
			// Terminal: same cleanup + result injection as the PR exit.
			completeFerment(opts.fermentId)
			injectRemoteResult(pi, result, promptPrefix, opts, {
				actionSuffix:
					"\n\n---\n\nThe user pushed the remote branch and pulled it locally — the working branch now contains all remote commits. No local sync (rsync) was performed.",
			})
			return true
		}
		if (choice === SYNC) {
			trackRemoteExecution("sync.started", promptPrefix)
			const synced = await syncRemoteChanges(ctx, opts.remoteSession)
			trackRemoteExecution(synced ? "sync.completed" : "sync.failed", promptPrefix)
			// Terminal action: a SUCCESSFUL pull retires the kept-alive session
			// (a failed pull keeps it — the user may retry or steer).
			if (synced) {
				try {
					await deleteRemoteSession(opts.remoteSession, apiKey, { endpoint: process.env.KIMCHI_REMOTE_ENDPOINT })
				} catch (err) {
					ctx.ui.notify(
						`The changes synced, but the remote session could not be deleted: ${errMessage(err)} — the server cleans it up on TTL.`,
						"warning",
					)
				}
			}
			completeFerment(opts.fermentId)
			injectRemoteResult(pi, result, promptPrefix, opts, {
				actionSuffix:
					"\n\n---\n\nThe user reviewed the remote PR diff and then synced the remote changes to their local working tree. Review the synced files if needed.",
			})
			return true
		}
		// DONE_KEEP_SESSION — nothing is deleted; steering stays available later.
		ctx.ui.notify(
			`Done — the branch ${git.branch} and the remote session are kept. Resume any time from the remote-sessions panel.`,
			"info",
		)
		return true
	}
}

interface PushRunArgs {
	connection: SandboxGitConnection
	baseSha: string
	git: PersistedGitWorkflow
	result: string
	opts: HandleRemoteCompletionOpts & { gitWorkflow: PersistedGitWorkflow; remoteSession: RemoteSessionMeta }
	apiKey: string
}

/**
 * Shared deterministic push core for the two push terminal actions. STRICT
 * ordering: re-harvest the current (post-steer) patch over SSH → scan it
 * for secrets → consent (hits require an explicit re-confirm) → sandbox
 * push → explicit local-fallback OFFER (never silent). Declining at any
 * gate leaves everything untouched. Returns true only when the push
 * actually succeeded.
 */
async function secretScannedConsentPush(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	run: PushRunArgs,
	consentTitle: string,
): Promise<boolean> {
	const { connection, baseSha, git } = run
	const branch = git.branch

	// 1. Re-harvest the CURRENT diff (post-steer state, deterministic range).
	const patchPath = run.opts.transcriptPath ? join(dirname(run.opts.transcriptPath), "remote-diff.diff") : undefined
	if (patchPath) writeFileSync(patchPath, "", "utf-8")
	let patchText = ""
	try {
		const stream = streamRemotePatch({
			connection,
			baseSha,
			patchPath,
			onChunk: (_v, chunk) => {
				patchText += chunk
			},
		})
		await stream.promise
	} catch (err) {
		ctx.ui.notify(
			`Could not re-harvest the diff for the secret scan: ${errMessage(err)}. Push aborted — back to the menu.`,
			"warning",
		)
		return false
	}

	// 2. Deterministic secret scan — runs BEFORE the consent prompt.
	const hits = scanDiffForSecrets(patchText)

	// 3. Consent. Clean scan → plain confirm; hits → strong warning + the
	//    distinct re-confirm choice (user decision: warn, never hard-block).
	const consent = await withBlocked(pi.events, "Remote execution complete", () =>
		withWorkingHidden(ctx.ui, () => {
			if (hits.length === 0) {
				return ctx.ui.select(`${consentTitle}? (secret scan: no hits)`, [consentTitle, "Cancel"])
			}
			const preview = hits
				.slice(0, 5)
				.map((hit) => `  ${hit.pattern}: ${hit.line}`)
				.join("\n")
			const extra = hits.length > 5 ? `\n  …and ${hits.length - 5} more` : ""
			return ctx.ui.select(
				`⚠ Secret scan found ${hits.length} possible credential(s) in the diff:\n${preview}${extra}\n\nPushing publishes these to the remote. Push anyway?`,
				[`Push anyway (I reviewed the hits)`, "Cancel"],
			)
		}),
	)
	// Declined or dismissed: NOTHING is pushed — not remotely, not locally.
	if (!consent || consent === "Cancel") return false

	// 4. Sandbox push (primary). Failure kinds are surfaced; the local
	//    fallback exists ONLY as an explicit second user choice.
	let push: PushResult = await pushBranchRemotely({ connection, branch })
	if (!push.ok) {
		const fallback = await withBlocked(pi.events, "Remote execution complete", () =>
			withWorkingHidden(ctx.ui, () =>
				ctx.ui.select(
					`Sandbox push failed (${push.ok ? "" : push.failure.kind}): ${push.ok ? "" : push.failure.reason}\n\nPush the exact same commits from your machine using your local git credentials instead?`,
					[PUSH_LOCAL_FALLBACK, "Cancel"],
				),
			),
		)
		if (fallback !== PUSH_LOCAL_FALLBACK) {
			ctx.ui.notify(
				`Push declined — nothing was pushed. The branch ${branch} stays on the sandbox; you can retry from the dropdown.`,
				"info",
			)
			return false
		}
		push = await pushViaLocalFallback({ connection, branch, localRepo: ctx.cwd, apiKey: run.apiKey })
		if (!push.ok) {
			ctx.ui.notify(
				`Local fallback push also failed (${push.failure.kind}): ${push.failure.reason}. Nothing was pushed — the branch stays on the sandbox.`,
				"error",
			)
			return false
		}
	}
	return true
}

/**
 * The consent-gated push + draft-PR terminal action: shared consent push →
 * draft PR via local gh → notify → kept-session cleanup. Returns true only
 * when terminal (caller completes the ferment + injects the result).
 */
async function pushAndOpenDraftPr(pi: ExtensionAPI, ctx: ExtensionContext, run: PushRunArgs): Promise<boolean> {
	const { git } = run
	const branch = git.branch
	const pushed = await secretScannedConsentPush(pi, ctx, run, `Push ${branch} to origin and open a draft PR`)
	if (!pushed) return false

	// 5. Draft PR. gh missing/unauthed → notified manual command, never silent.
	const goal = defaultFermentRuntime.getActive()?.goal
	const title = goal?.split("\n")[0]?.trim().slice(0, 90) || branch
	const body = `${run.result}\n\n---\n\nExecuted remotely by Kimchi; reviewed and pushed with explicit user consent.`
	const pr = createDraftPr({ localRepo: ctx.cwd, branch, baseBranch: git.baseBranch ?? undefined, title, body })
	if (pr.kind === "created") {
		ctx.ui.notify(`Draft PR opened: ${pr.url}`, "info")
	} else {
		ctx.ui.notify(
			`The branch was pushed, but no PR was opened — ${pr.reason}. Create it manually:\n${pr.command}`,
			"warning",
		)
	}

	// 6. Terminal cleanup: the kept session retires (honest warning when not).
	await deleteKeptRemoteSession(ctx, run.opts.remoteSession, run.apiKey)
	return true
}

/**
 * The consent-gated push + local pull terminal action: shared consent push
 * → fetch + checkout the branch from origin (fast-forward when it already
 * exists) → notify → kept-session cleanup. Never touches origin from the
 * local side; failures report the exact manual commands. Returns true only
 * when terminal.
 */
async function pushAndPullLocally(pi: ExtensionAPI, ctx: ExtensionContext, run: PushRunArgs): Promise<boolean> {
	const { git } = run
	const branch = git.branch
	const pushed = await secretScannedConsentPush(pi, ctx, run, `Push ${branch} to origin and pull it locally`)
	if (!pushed) return false

	const pulled = pullBranchLocally({ localRepo: ctx.cwd, branch })
	if (pulled.kind === "failed") {
		// The push DID happen — the branch is on origin; only the local side
		// failed. Honest, non-terminal: back to the menu so the user can fix
		// their worktree (or pick another action). The manual commands are
		// always surfaced.
		ctx.ui.notify(
			`Pushed ${branch} to origin, but the local pull failed: ${pulled.reason}\nDo it manually:\n${pulled.command}`,
			"error",
		)
		return false
	}
	ctx.ui.notify(
		pulled.action === "created"
			? `Pushed and pulled — on ${branch} (created from origin/${branch}).`
			: `Pushed and pulled — on ${branch}, fast-forwarded to origin/${branch}.`,
		"info",
	)
	// Fire-and-forget plannotator code-review on the freshly checked-out
	// local branch. When @plannotator/pi-extension is not installed the emit
	// is a no-op (nobody listens) — the local state is ready either way.
	firePlannotatorCodeReview(pi, ctx.cwd, git.baseBranch ?? undefined)
	ctx.ui.notify(
		"Opening the Plannotator code-review UI in your browser (needs @plannotator/pi-extension installed). If nothing opens, the extension is not installed.",
		"info",
	)
	await deleteKeptRemoteSession(ctx, run.opts.remoteSession, run.apiKey)
	return true
}

/**
 * Emits plannotator's shared `code-review` request against the LOCAL repo
 * (branch-vs-base — the remote branch was just pulled). fire-and-forget,
 * https://github.com/backnotprop/plannotator — a missing extension simply
 * never invokes the respond callback.
 */
function firePlannotatorCodeReview(pi: ExtensionAPI, cwd: string, baseBranch?: string): void {
	const payload: Record<string, unknown> = { cwd }
	if (baseBranch) payload.defaultBranch = baseBranch
	pi.events.emit(PLANNOTATOR_REQUEST_CHANNEL, {
		requestId: `kimchi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		action: "code-review",
		payload,
		respond: () => {},
	})
}

/**
 * Delete the kept-alive remote session after a terminal action. A failure is
 * notified but never aborts the flow — the server TTL is the backstop.
 */
async function deleteKeptRemoteSession(
	ctx: ExtensionContext,
	remoteSession: RemoteSessionMeta,
	apiKey: string,
): Promise<void> {
	if (process.env.KIMCHI_E2E_FAKE_SANDBOX_GIT === "1") return // TUI-E2E seam: nothing real to delete
	try {
		await deleteRemoteSession(remoteSession, apiKey, { endpoint: process.env.KIMCHI_REMOTE_ENDPOINT })
	} catch (err) {
		ctx.ui.notify(
			`The remote session could not be deleted: ${errMessage(err)} — the server cleans it up on TTL.`,
			"warning",
		)
	}
}

/**
 * Opens the streamed diff overlay (full-screen like the conversation
 * viewer). The stream appends the full patch to the sibling patch file on
 * the FIRST show only; on close, the capped patch is persisted as a
 * remote_run:diff transcript entry (once) and the user is (once) notified
 * of the patch file path. Re-opens are stream-only: no file re-append, no
 * second entry. Returns whether the transcript entry was persisted.
 */
async function showDiffOverlay(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	opts: {
		transcriptPath?: string
		baseSha: string
		connection: SandboxGitConnection
		viewerTitle: string
		statText: string
		diffPersisted: boolean
	},
): Promise<boolean> {
	const { transcriptPath, baseSha, connection, viewerTitle, statText, diffPersisted } = opts
	const patchPath = !diffPersisted && transcriptPath ? join(dirname(transcriptPath), "remote-diff.diff") : undefined
	let stream: RemotePatchStream | undefined
	let streamError: Error | undefined

	await ctx.ui.custom<undefined>(
		(tui, theme, _keybindings, done) => {
			const viewer = new DiffViewer(tui, theme, { title: viewerTitle }, () => done(undefined))
			stream = streamRemotePatch({
				connection,
				baseSha,
				patchPath,
				onChunk: (_version, chunk) => viewer.appendChunk(chunk),
			})
			stream.promise.then(
				() => viewer.finish(),
				(err: unknown) => {
					streamError = err instanceof Error ? err : new Error(errMessage(err))
					viewer.finish()
				},
			)
			return viewer
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: "90%" } },
	)

	// Overlay closed — stop an in-flight stream; already-resolved streams no-op.
	let cancelled = false
	if (stream) {
		stream.cancel()
		cancelled = (await stream.promise.catch(() => undefined))?.cancelled === true
	}
	if (streamError) {
		ctx.ui.notify(`Diff stream ended early: ${streamError.message}`, "warning")
	}

	if (diffPersisted || !patchPath) return diffPersisted
	try {
		const raw = readFileSync(patchPath, "utf8")
		const allLines = raw.split("\n")
		const capped = allLines.length > DIFF_MESSAGE_CAP_LINES
		const patch = (capped ? allLines.slice(0, DIFF_MESSAGE_CAP_LINES) : allLines).join("\n")
		const details: RemoteRunDiffDetails = {
			title: viewerTitle,
			stat: statText,
			patch,
			capped: capped || undefined,
			patchPath,
		}
		pi.appendEntry(REMOTE_DIFF_ENTRY_TYPE, details)
		ctx.ui.notify(
			cancelled
				? `Partial diff saved at ${patchPath} (stream interrupted) — persisted in this transcript as an expandable entry.`
				: `Diff saved at ${patchPath} — persisted in this transcript as an expandable entry.`,
			"info",
		)
		return true
	} catch (err) {
		ctx.ui.notify(`The diff could not be persisted: ${errMessage(err)}`, "warning")
		return diffPersisted
	}
}

/**
 * Ensures the FULL patch exists on disk: reused when a previous show already
 * streamed it, otherwise streamed now (no overlay).
 */
async function ensurePatchOnDisk(
	ctx: ExtensionContext,
	opts: {
		transcriptPath?: string
		baseSha: string
		connection: SandboxGitConnection
		branch: string
		diffPersisted: boolean
	},
): Promise<{ patchPath: string; persisted: boolean } | undefined> {
	const { transcriptPath, baseSha, connection, branch, diffPersisted } = opts
	const patchPath = transcriptPath
		? join(dirname(transcriptPath), "remote-diff.diff")
		: join(tmpdir(), `kimchi-remote-diff-${branch.replace(/[^\w.-]/g, "-")}.diff`)

	if (diffPersisted) return { patchPath, persisted: true }
	mkdirSync(dirname(patchPath), { recursive: true })
	writeFileSync(patchPath, "", "utf-8")
	try {
		const stream = streamRemotePatch({
			connection,
			baseSha,
			patchPath,
			onChunk: () => {},
		})
		await stream.promise
		return { patchPath, persisted: true }
	} catch (err) {
		ctx.ui.notify(`Diff stream failed: ${errMessage(err)} — back to the menu.`, "warning")
		return undefined
	}
}

/**
 * INTERACTIVE browser review: serves the diff page from a one-shot local
 * server (plannotator-style) and BLOCKS on the human's decision — approve,
 * request-changes with per-line comments, or cancel back to the menu.
 * The page opens fully offline; the only network hop is the loopback POST
 * that carries the decision.
 */
async function runBrowserReview(
	ctx: ExtensionContext,
	opts: {
		transcriptPath?: string
		baseSha: string
		connection: SandboxGitConnection
		branch: string
		viewerTitle: string
		statText: string
		diffPersisted: boolean
	},
): Promise<{ decision: ReviewDecision; persisted: boolean } | undefined> {
	const ensured = await ensurePatchOnDisk(ctx, opts)
	if (!ensured) return undefined
	const patch = readFileSync(ensured.patchPath, "utf-8")

	// E2E seam: canned decision, no server/browser (real browser can't be
	// driven from the TUI test rig; server paths are unit-tested).
	const canned = process.env.KIMCHI_E2E_FAKE_BROWSER_REVIEW
	if (canned) {
		const decision: ReviewDecision = canned.startsWith("changes")
			? {
					kind: "request-changes",
					summary: canned.includes(":") ? canned.slice(canned.indexOf(":") + 1) : undefined,
					comments: [
						{
							file: "src/login.ts",
							line: 42,
							side: "new",
							code: "const attempts = 3",
							text: "make this 5 and add a delay",
						},
					],
				}
			: canned === "approve"
				? { kind: "approve" }
				: { kind: "closed" }
		return { decision, persisted: ensured.persisted }
	}

	const html = buildDiffHtmlDocument({
		title: opts.viewerTitle,
		subtitle: opts.statText,
		patch,
		interactive: true,
	})
	let server: ReviewServer
	try {
		server = await startReviewServer({ html })
	} catch (err) {
		ctx.ui.notify(`Could not start the review server: ${errMessage(err)} — back to the menu.`, "warning")
		return undefined
	}
	const opened = openInBrowser(server.url)
	ctx.ui.notify(
		opened.opened
			? `Interactive review open in your browser — decide there; this terminal is waiting. (${server.url})`
			: `Could not open the browser (${opened.detail}). Open manually: ${server.url}`,
		"info",
	)
	const decision = await server.decision
	return { decision, persisted: ensured.persisted }
}

/**
 * Browser review comments → steering prompt for the remote agent. Every
 * comment carries its file/line anchor plus the code snippet it was placed
 * on; the agent is asked to address ALL of them.
 */
function formatReviewComments(summary: string | undefined, comments: ReviewComment[]): string {
	const parts: string[] = []
	if (summary?.trim()) parts.push(`Overall note: ${summary.trim()}`)
	if (comments.length > 0) {
		parts.push("The reviewer left these comments on the diff:")
		comments.forEach((c, i) => {
			const anchor = c.file ? (c.line ? `${c.file}:${c.line}` : c.file) : "(unanchored)"
			parts.push(`${i + 1}. [${anchor}] ${c.text}${c.code ? `\n   on: ${c.code}` : ""}`)
		})
	}
	if (parts.length === 0) return ""
	parts.push("Address every comment above. The server-side workflow (commit, artifacts) stays exactly the same.")
	return parts.join("\n")
}

/**
 * Opens the diff in the system's external viewer (IDE or the OS default
 * .patch app — see ui/external-viewer.ts). The FULL patch must exist on disk
 * first: reused when a previous show already streamed it, otherwise
 * streamed here (no overlay). Returns whether a complete patch file exists
 * (so a later "Show the diff" skips the file re-append).
 */
async function showDiffExternally(
	ctx: ExtensionContext,
	opts: {
		transcriptPath?: string
		baseSha: string
		connection: SandboxGitConnection
		branch: string
		diffPersisted: boolean
	},
): Promise<boolean> {
	const ensured = await ensurePatchOnDisk(ctx, opts)
	if (!ensured) return opts.diffPersisted

	const opened = openExternalDiff(ensured.patchPath)
	if (opened.opened) {
		ctx.ui.notify(`Opened the diff externally: ${ensured.patchPath}`, "info")
	} else {
		ctx.ui.notify(
			`Could not open the external viewer (${opened.detail}). The patch is at ${ensured.patchPath}`,
			"warning",
		)
	}
	return ensured.persisted
}
