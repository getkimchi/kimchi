/**
 * runRemoteAgent — the cloud equivalent of `runAgent()`.
 *
 * Authenticates to a workspace, creates an ACP session on the sandbox worker,
 * connects via `AcpSessionClient`, sends a prompt, and returns the result.
 *
 * Designed to be reusable: when a `remote: true` agent type is registered
 * (Task 4+5 from the plan), `AgentManager.startAgent()` can call this function
 * instead of `runAgent()`.
 *
 * ## Resilience
 *
 * A transient WebSocket disconnect (laptop sleep, Wi-Fi drop) during `prompt()`
 * surfaces as a `RemoteConnectionError` rather than a fatal failure. The runner
 * then runs a recovery state machine driven by `GET /api/session/{name}` status
 * polls:
 *
 * - **alive + still running** → reattach with a fresh `AcpSessionClient` (worker
 *   takeover) using re-authenticated creds, capped at 3 backoff retries.
 * - **finished while away** (`!agentRunning && finishedAt`) → returns a
 *   `stopReason: "recovered"` placeholder (Phase 2 reconstructs the real result
 *   from the remote `session.jsonl`).
 * - **unreachable** (`!alive`) → re-auth + `waitForWorkspaceReady`, ~3 attempts;
 *   then fails honestly with "result unknown" and leaves the session undeleted.
 *
 * Session deletion is deferred: it only happens after a confirmed completion.
 * Error paths never delete (the session may still be needed for inspection or
 * Phase 2 recovery). An abort during recovery does a best-effort delete.
 */

import { randomUUID } from "node:crypto"
import { setTimeout as timersSleep } from "node:timers/promises"
import { authenticateWorkspace } from "../../../sandbox/cloud/auth.js"
import { waitForWorkspaceReady } from "../../../sandbox/cloud/readiness.js"
import type { WorkspaceCredentials, WorkspaceResourcesConfig } from "../../../sandbox/cloud/types.js"
import {
	type AcpSessionCallbacks,
	AcpSessionClient,
	extractFinalAssistantText,
	RemoteConnectionError,
} from "../../../sandbox/worker/acp-client.js"
import { WorkerClient } from "../../../sandbox/worker/client.js"
import { createSession, deleteSession, getSession } from "../../../sandbox/worker/sessions.js"
import { type SessionStatus, WorkerError } from "../../../sandbox/worker/types.js"
import { appendTranscriptGapMarker } from "../../remote-run/session-recovery.js"
import { provisionGitCredential } from "../../teleport/provisioning/git-provision.js"
import { syncLocalChangesAfterClone } from "../../teleport/provisioning/sync-local-changes.js"

/** Remote session metadata for reconnection/steer/resume/sync. */
export interface RemoteSessionMeta {
	workspaceId: string
	sessionName: string
	wsUrl: string
	host: string
	/** The unique remote working directory (e.g. /home/sandbox/acp-a1b2c3d4). */
	cwd: string
}

export interface RemoteRunOptions {
	/** Cloud API key for workspace authentication. */
	apiKey: string
	/** Override the cloud API endpoint (used by tests). */
	endpoint?: string
	/** Abort signal — aborts the remote session. */
	signal?: AbortSignal
	/** Event callbacks — same shape as RunOptions callbacks from agent-runner.ts. */
	callbacks?: AcpSessionCallbacks
	/** Git clone details for provisioning the sandbox with a repo (like /teleport --fast). */
	gitDetails?: { repo: string; branch?: string; targetDirectory: string; noHistory?: boolean }
	/** Local working directory to diff-sync on top of the clone (when gitDetails is set). */
	localPath?: string
	/** Git credential to provision on the sandbox before cloning. */
	gitCredential?: { host: string; token: string }
	/** Workspace name passed to authenticateWorkspace (used for matching/reuse). */
	workspaceName?: string
	/**
	 * Workspace resource requests (Kubernetes quantity strings) forwarded on
	 * the upsert PUT. The caller passes them only when minting the workspace —
	 * resources are create-time-only and immutable server-side.
	 */
	resources?: WorkspaceResourcesConfig
	/**
	 * Called after `acpClient.initialize()` and before `acpClient.prompt()`,
	 * giving the caller access to the live AcpSessionClient so it can be
	 * wrapped in a RemoteAgentSession adapter. Also called again after a
	 * successful reattach so the caller can rebind to the new client.
	 */
	onReady?: (acpClient: AcpSessionClient, meta: RemoteSessionMeta) => void
	/** Local output file path for transcript backfill during recovery. */
	outputFile?: string
	/**
	 * Called when the runner enters the reconnecting state (WS transport
	 * failure detected, attempting reattach). The caller should set the
	 * agent record status to "reconnecting" so the UI reflects the state.
	 * Called with `false` when the runner successfully reattaches and
	 * resumes normal operation.
	 */
	onReconnecting?: (reconnecting: boolean) => void
	/**
	 * Override the reconnect backoff schedule (ms) — one delay per reattach
	 * attempt. Defaults to `[2000, 4000, 8000]`. The first element is also
	 * used as the inter-attempt delay when reviving an unreachable workspace.
	 * Primarily a test seam; production callers should leave this unset.
	 */
	reconnectBackoffsMs?: number[]
	/** Grace period for trusting a quiet turn after a disconnect. When
	 * `session/load` keeps reporting a turn in progress but the worker's
	 * turn-level activity (agentRunning, from the remote agent_start/end
	 * events) has stayed false for this long, the agent's work is considered
	 * done — the ACP turn bookkeeping can never unwind without its owning
	 * client, so the result is recovered from the remote transcript.
	 * Defaults to 2 minutes (covers LLM retry backoffs). Test seam. */
	turnSettleGraceMs?: number
	/** Override the status-poll cadence (ms) for the always-on poller and
	 *  the recovery watch loop. Defaults to ~15s + up to 5s jitter (jitter is
	 *  dropped when overridden). Test seam; production callers leave unset. */
	pollIntervalMs?: number
}

export interface RemoteRunResult {
	/** The assistant's full response text. */
	responseText: string
	/** Why the prompt stopped: "end_turn" (normal), "cancelled", "recovered"
	 *  (result replayed after a disconnect), or "recovery_failed" (the replay
	 *  could not produce the result — the run's outcome is unknown). */
	stopReason: string
	/** Token usage for the turn (if reported by the agent). */
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
	/** Remote session metadata for reconnection/steer/resume/sync. */
	remoteSession: RemoteSessionMeta
	/** Recovery note when the result was recovered after a disconnect (undefined for normal runs). */
	recoveryNote?: string
}

/** Per-call timeout for createSession: 5min — large repos take a while to clone. */
const SESSION_CREATE_TIMEOUT_MS = 5 * 60_000

/** Reconnect backoff schedule (2s, 4s, 8s) — one delay per reattach attempt. */
const DEFAULT_RECONNECT_BACKOFFS_MS = [2_000, 4_000, 8_000]
/** How long the pi agent turn must stay quiet (agentRunning=false) before
 * we treat the work as finished and recover from the transcript. Sized past
 * pi-mono LLM retry backoffs (~64s) with margin. */
const DEFAULT_TURN_SETTLE_GRACE_MS = 120_000
/** Always-on status poll cadence: ~15s fixed + up to 5s jitter. */
const POLL_INTERVAL_MS = 15_000
const POLL_JITTER_MS = 5_000
/** Cap on re-auth + readiness attempts when a session is reported `!alive`. */
const REVIVE_MAX_ATTEMPTS = 3
/** Consecutive failed status polls before the recovery loop refreshes
 *  credentials and rebuilds the HTTP client — covers expired connect tokens
 *  (spec Q6: re-auth on 401/403) and wedged transports. */
const POLL_FAILURES_BEFORE_REFRESH = 3
/** Recovery note when the result was recovered by replaying the finished
 *  session over ACP (the transcript file could not be fetched). Same
 *  confidence contract as the file-based note: the text is the agent's
 *  final output — do not re-run the task. */
const REPLAY_RECOVERY_NOTE =
	"This result was recovered by replaying the remote session over ACP after a network disconnect. It is the agent's complete and final output — treat it as the definitive result of the task; do not re-run, re-execute, or re-verify it."

/** Builds an Error flagged as an AbortError (the `name` is what the codebase checks). */
function makeAbortError(): Error {
	const err = new Error("Aborted")
	err.name = "AbortError"
	return err
}

/** Detects the remote server's session/load rejection for a session whose
 *  turn (owned by the dead pre-disconnect connection) is still in flight.
 *  The server message is: "session <id> has a turn in progress; cancel it first". */
function isTurnInProgressError(err: unknown): boolean {
	return err instanceof Error && /turn in progress/i.test(err.message)
}

/** Union of a normal prompt result and the recovery placeholder shape. */
type PromptOutcome = { stopReason: string; usage?: RemoteRunResult["usage"] }

// ---------------------------------------------------------------------------
// Shared recovery engine — the poll/reattach/replay state machine used by
// BOTH the mid-run disconnect recovery (inside runRemoteAgent) and the
// fresh-process resume (attachRemoteAgent). One implementation, two entries:
// a fresh-process attach enters with the same initial conditions as a
// mid-run disconnect (attached=false, no live WS, known acpSessionId).
// ---------------------------------------------------------------------------

/** Mutable run state shared between the caller and the recovery engine —
 *  reauth/reattach swap these in place so every consumer (recovery loop,
 *  main flow, finally block) sees the latest handles. */
interface RemoteRecoveryState {
	creds: WorkspaceCredentials
	client: WorkerClient
	/** The live ACP client — undefined for a fresh-process attach (the loop
	 *  constructs one on the first reattach). */
	acpClient: AcpSessionClient | undefined
	/** The ACP session id — session/load attaches by id, never by name. */
	acpSessionId: string | undefined
	/** Accumulated response text (kept current by the wrapped onTextDelta). */
	responseText: string
	/** Recovery note set when the result was recovered after a disconnect. */
	recoveryNote: string | undefined
	/** Remote session metadata (kept in sync with creds by applyRecoveryCreds). */
	meta: RemoteSessionMeta
	/** Engine-internal scratch: the last status poll was auth-rejected
	 *  (401/403) — forces a credentials refresh on the next loop tick. */
	pollAuthRejected: boolean
}

/** Immutable configuration for one run of the recovery engine. */
interface RecoveryConfig {
	sessionName: string
	workspaceId: string
	apiKey: string
	workspaceName: string
	endpoint: string | undefined
	signal: AbortSignal | undefined
	outputFile: string | undefined
	cwd: string
	onReady?: (acpClient: AcpSessionClient, meta: RemoteSessionMeta) => void
	onReconnecting?: (reconnecting: boolean) => void
	backoffs: number[]
	turnSettleGraceMs: number
	reviveDelayMs: number
	pollDelayMs: () => number
	wrappedCallbacks: AcpSessionCallbacks
}

/** Applies freshly authenticated credentials — the creds handle AND the
 *  session meta stay in sync, so onReady/remoteSession consumers never see a
 *  stale endpoint after a revive or reattach moved the workspace. */
function applyRecoveryCreds(st: RemoteRecoveryState, fresh: WorkspaceCredentials): void {
	st.creds = fresh
	st.meta.wsUrl = fresh.wsUrl
	st.meta.host = fresh.host
}

/** Fetches the current session status; returns undefined on transient failure. */
async function safeGetSession(st: RemoteRecoveryState, config: RecoveryConfig): Promise<SessionStatus | undefined> {
	try {
		st.pollAuthRejected = false
		return await getSession(st.client, config.sessionName, config.signal)
	} catch (err) {
		if (config.signal?.aborted) throw makeAbortError()
		// A definitive 404 (session deleted/reaped server-side) is not a
		// transient failure — fail honestly instead of retrying forever.
		// (The always-on poller treats 404 as terminal too.)
		if (err instanceof WorkerError && err.status === 404) {
			throw new Error("remote session no longer exists — result unknown")
		}
		// Auth rejected — the connect token likely expired during the
		// outage (spec Q6). Flagged so the recovery loop refreshes creds.
		st.pollAuthRejected = err instanceof WorkerError && (err.status === 401 || err.status === 403)
		return undefined
	}
}

/** Re-authenticates and waits for the sandbox to wake, up to REVIVE_MAX_ATTEMPTS times. */
async function tryReviveWorkspace(st: RemoteRecoveryState, config: RecoveryConfig): Promise<boolean> {
	for (let i = 0; i < REVIVE_MAX_ATTEMPTS; i++) {
		if (config.signal?.aborted) throw makeAbortError()
		try {
			applyRecoveryCreds(
				st,
				await authenticateWorkspace(config.workspaceId, config.apiKey, config.workspaceName, {
					endpoint: config.endpoint,
				}),
			)
			await waitForWorkspaceReady({ wsUrl: st.creds.wsUrl, connectToken: st.creds.connectToken, signal: config.signal })
			await st.client.close().catch(() => {})
			st.client = new WorkerClient(st.creds)
			const s = await getSession(st.client, config.sessionName, config.signal)
			if (s.alive) return true
		} catch (_err) {
			if (config.signal?.aborted) throw makeAbortError()
			// network error or not yet ready — retry after backoff
		}
		if (i < REVIVE_MAX_ATTEMPTS - 1) await timersSleep(config.reviveDelayMs, undefined, { signal: config.signal })
	}
	return false
}

/** Replay outcome: the recovered final text, or the reason it failed. */
type ReplayOutcome = { text: string } | { error: string }

/** Attaches a fresh ACP client to the finished session and extracts the
 *  final assistant text from the session/load replay. Returns undefined
 *  when no session id is known or the replay cannot be obtained. */
async function recoverTextViaReplay(
	st: RemoteRecoveryState,
	config: RecoveryConfig,
): Promise<ReplayOutcome | undefined> {
	if (!st.acpSessionId) return undefined
	const replayClient = new AcpSessionClient({
		sessionName: config.sessionName,
		credentials: st.creds,
		signal: config.signal,
		cwd: config.cwd,
		sessionId: st.acpSessionId,
		captureLoadReplay: true,
	})
	try {
		await replayClient.initialize()
		const text = extractFinalAssistantText(replayClient.loadReplay)
		return text.trim()
			? { text }
			: {
					error: "the replayed session contained no final assistant message (the turn may still have been running)",
				}
	} catch (replayErr) {
		if (config.signal?.aborted) throw makeAbortError()
		return {
			error: `the remote session did not answer session/load (${
				replayErr instanceof Error ? replayErr.message : String(replayErr)
			})`,
		}
	} finally {
		replayClient.close()
	}
}

/** Shared recovery outcome: recover the result via session/load replay.
 *  Reads the current creds (mutated by re-auth) at call time. */
async function recoverOutcome(st: RemoteRecoveryState, config: RecoveryConfig): Promise<PromptOutcome> {
	// The replay (and the post-recovery deleteSession) hit the worker with
	// current creds — which can be minutes old after a long watch (connect
	// tokens expire). Best-effort refresh so the recovery doesn't run on a
	// stale token.
	try {
		if (!config.signal?.aborted) {
			applyRecoveryCreds(
				st,
				await authenticateWorkspace(config.workspaceId, config.apiKey, config.workspaceName, {
					endpoint: config.endpoint,
				}),
			)
			await st.client.close().catch(() => {})
			st.client = new WorkerClient(st.creds)
		}
	} catch (_refreshErr) {
		// Cloud API unreachable — replay with the creds we have.
	}
	// Recover the result at the protocol level: session/load replays the
	// finished session's history to a fresh client; the final assistant
	// message is the answer. (The rsync'd session file is not a source — the
	// remote kimchi writes it where the worker expects only when its --session
	// arg is honored, which deployed remotes don't.)
	const replay = await recoverTextViaReplay(st, config)
	let gapNote: string
	let recovered = true
	if (replay && "text" in replay) {
		st.responseText = replay.text
		st.recoveryNote = REPLAY_RECOVERY_NOTE
		gapNote = "disconnect window — local streaming was interrupted; the final result was recovered via session replay"
	} else {
		recovered = false
		const reason = replay?.error ?? "no session id was captured to replay"
		st.responseText = `(remote agent completed during disconnect; the result could not be recovered — ${reason})`
		st.recoveryNote = `Recovery failed: ${reason}. The result of the remote run is unknown — before re-running or re-dispatching anything, ask the user how to proceed.`
		gapNote = `disconnect window — the result could not be recovered (${reason})`
	}
	// The transcript-gap marker is best-effort — never fail the recovery over it.
	if (config.outputFile) {
		await appendTranscriptGapMarker(config.outputFile, gapNote).catch(() => {})
	}
	return { stopReason: recovered ? "recovered" : "recovery_failed", usage: undefined }
}

/** Inner recovery loop — throws on any failure (abort or unrecoverable). */
async function recoverFromDisconnectInner(st: RemoteRecoveryState, config: RecoveryConfig): Promise<PromptOutcome> {
	config.onReconnecting?.(true)
	let reattachAttempts = 0
	let attached = false
	let turnQuietSince: number | undefined
	/** Consecutive failed polls — triggers a credentials/client refresh. */
	let consecutivePollFailures = 0
	/** True while every poll since the last successful one has failed. */
	let pollsFailing = false
	/** Set by the reattached client's foreign-response signal — the remote
	 *  turn ended while attached. */
	let remoteTurnEnded = false
	while (true) {
		if (config.signal?.aborted) throw makeAbortError()

		const status = await safeGetSession(st, config)

		// Poll failure ≠ confirmed dead (spec Q3: with the local network down,
		// every HTTP poll fails while the sandbox is fine). Keep retrying
		// silently at poll cadence — no revive budget, no deadline, and
		// `attached` stays as-is: the session's state is unknown, not dead.
		if (!status) {
			// The connect token may have expired during the outage (spec Q6:
			// re-auth on 401/403) or the HTTP transport may be wedged —
			// refresh credentials and rebuild the client so this loop isn't
			// polling with dead credentials forever. (Pre-fix, the !alive
			// revive path doubled as this refresh; poll failures no longer
			// route through it.)
			if (st.pollAuthRejected || ++consecutivePollFailures >= POLL_FAILURES_BEFORE_REFRESH) {
				try {
					applyRecoveryCreds(
						st,
						await authenticateWorkspace(config.workspaceId, config.apiKey, config.workspaceName, {
							endpoint: config.endpoint,
						}),
					)
					await st.client.close().catch(() => {})
					st.client = new WorkerClient(st.creds)
					consecutivePollFailures = 0
				} catch (_refreshErr) {
					if (config.signal?.aborted) throw makeAbortError()
					// Cloud API unreachable too — keep polling with what we have.
				}
			}
			pollsFailing = true
			await timersSleep(config.pollDelayMs(), undefined, { signal: config.signal })
			continue
		}
		consecutivePollFailures = 0
		// Connectivity regained after failures with a live turn still running —
		// restore the reattach budget that transient failures burned during the
		// outage, so the session is live-resumed (onReconnecting(false)) instead
		// of being watched in "reconnecting" until the turn ends.
		if (pollsFailing) {
			pollsFailing = false
			if (!attached && status.alive && status.agentRunning && reattachAttempts > 0) {
				reattachAttempts = 0
			}
		}

		// Unreachable: a successful poll confirmed the sandbox pod is down or
		// hibernated. Try to wake it.
		if (!status.alive) {
			// Revive replaces creds/client — any earlier attach is stale.
			attached = false
			if (await tryReviveWorkspace(st, config)) {
				// The quiesce clock restarts from a clean post-revive baseline —
				// the pre-hibernation quiet window must not count against the
				// just-revived turn (the worker may not have resumed it yet).
				turnQuietSince = undefined
				continue
			}
			// ponytail: leave the session undeleted — result is unknown and the
			// session may still be inspectable/recoverable later.
			throw new Error("remote session no longer reachable — result unknown")
		}

		// Track continuous turn quiescence. agentRunning comes from the
		// remote process's agent_start/agent_end events (a UDS independent
		// of our WS) and honestly reports whether any pi agent turn is live.
		// It can dip false for milliseconds between chained prompt calls, so
		// require a sustained quiet window before trusting it.
		if (status.agentRunning) {
			turnQuietSince = undefined
		} else {
			turnQuietSince ??= Date.now()
		}

		// Finished while we were disconnected — result is on disk but not yet
		// fetchable over the gap. Fetch the remote session.jsonl, parse the
		// final assistant text, and backfill the local transcript gap.
		if (!status.agentRunning && status.finishedAt) {
			return recoverOutcome(st, config)
		}

		// The attached client received a response for a request it never sent —
		// the ORIGINAL connection's prompt response, i.e. the turn ended while
		// we were attached. Recover at once, while the remote child is still
		// alive to answer the replay (the sandbox may reap it shortly after
		// the turn ends).
		if (remoteTurnEnded) {
			st.acpClient?.close()
			return recoverOutcome(st, config)
		}

		// Turn quiet past the grace window → the agent's work is done.
		// (Once the owning client is gone, the ACP turn bookkeeping can
		// never unwind — observed 4+ minutes of "turn in progress" with the
		// agent long finished — so quiescence, not attachability, decides.)
		// Only while UNATTACHED: when attached, the turn's end is observed
		// directly (the original prompt's response arrives with an unknown
		// id — remoteTurnEnded) and agentRunning is unreliable (observed
		// false mid-turn), so the quiet clock would fire while the turn is
		// still running on long tasks.
		const quietFor = turnQuietSince === undefined ? 0 : Date.now() - turnQuietSince
		if (!attached && turnQuietSince !== undefined && quietFor >= config.turnSettleGraceMs) {
			st.acpClient?.close()
			return recoverOutcome(st, config)
		}

		// Alive + still running → attach to the EXISTING ACP session via
		// session/load — never session/new, and never re-prompt: the original
		// prompt's turn is owned by the dead connection, so re-sending it
		// would restart the task from scratch (duplicating side effects).
		// The attempt budget only covers TRANSPORT failures — a session whose
		// turn is still in flight is healthy, just not finished yet.
		if (reattachAttempts >= config.backoffs.length) {
			if (!status.agentRunning) {
				// Attach kept failing with the session alive and the turn quiet
				// (e.g. the remote process died mid-turn). The transcript may
				// still hold a partial result — recover it instead of failing
				// with "result unknown".
				return recoverOutcome(st, config)
			}
			// The agent is still running — never recover/delete a live session
			// (spec Q5). Fall through to watch-only polling below; the
			// quiesce/finished branches above decide recovery (spec Q4
			// secondary: poll-until-finished).
		}

		// Watch cadence: once attached (or out of reattach budget with the
		// agent still running) this is a steady watch, not a retry — poll at
		// the spec's ~15s cadence, not the reconnect backoff.
		const watchOnly = attached || reattachAttempts >= config.backoffs.length
		await timersSleep(
			watchOnly ? config.pollDelayMs() : config.backoffs[Math.min(reattachAttempts, config.backoffs.length - 1)],
			undefined,
			{ signal: config.signal },
		)

		if (watchOnly) {
			// Already attached to the live session — poll only. Turn updates
			// stream over the attached connection; the quiesce/finished
			// branches above decide when to recover.
			continue
		}

		// Re-authenticate (token may have expired during the disconnect).
		try {
			applyRecoveryCreds(
				st,
				await authenticateWorkspace(config.workspaceId, config.apiKey, config.workspaceName, {
					endpoint: config.endpoint,
				}),
			)
		} catch {
			if (config.signal?.aborted) throw makeAbortError()
			reattachAttempts++
			continue
		}
		await st.client.close().catch(() => {})
		st.client = new WorkerClient(st.creds)
		st.acpClient?.close()
		const reattachClient = new AcpSessionClient({
			sessionName: config.sessionName,
			credentials: st.creds,
			callbacks: config.wrappedCallbacks,
			signal: config.signal,
			cwd: config.cwd,
			sessionId: st.acpSessionId,
			// The original connection's prompt response arrives with an id this
			// client never sent once the turn ends — the turn-end signal.
			onForeignResponse: () => {
				remoteTurnEnded = true
			},
		})
		st.acpClient = reattachClient
		try {
			await reattachClient.initialize()
		} catch (err) {
			reattachClient.close()
			if (isTurnInProgressError(err)) {
				// Older remotes reject mid-turn loads. NEVER cancel the turn —
				// wait for quiesce (handled above) or a settle.
				continue
			}
			reattachAttempts++
			if (err instanceof RemoteConnectionError) continue
			throw err
		}
		attached = true
		// Newer remotes allow mid-turn loads: after attaching, the live
		// turn's updates stream to this connection. Older remotes only
		// accept a load after the turn settled, in which case the quiesce
		// branch recovers on the next poll. Either way: rebind, resume UI,
		// and keep polling — do NOT recover immediately (the turn may
		// still be running).
		if (config.onReady) config.onReady(reattachClient, st.meta)
		config.onReconnecting?.(false)
	}
}

/**
 * Recovery entry point. Wraps the inner loop so that an abort surfaced from
 * any await point triggers a best-effort `deleteSession` before rethrowing —
 * a user kill while disconnected (or while resumed) still tries to clean up
 * the remote session.
 */
async function runRecovery(st: RemoteRecoveryState, config: RecoveryConfig): Promise<PromptOutcome> {
	try {
		return await recoverFromDisconnectInner(st, config)
	} catch (err) {
		if (config.signal?.aborted) {
			await deleteSession(st.client, config.sessionName).catch(() => {})
			throw makeAbortError()
		}
		throw err
	}
}

/**
 * Runs a single-turn prompt on a remote sandbox worker via ACP.
 *
 * 1. Authenticates to the workspace (auto-resolves or creates one)
 * 2. Waits for the sandbox to be ready
 * 3. Creates an ACP session with `yolo: true`
 * 4. Connects via `AcpSessionClient`
 * 5. Sends the prompt and collects the response, recovering from transient
 *    WebSocket disconnects instead of failing.
 * 6. Returns `RemoteRunResult` with response text and session metadata
 */
export async function runRemoteAgent(
	workspaceId: string,
	prompt: string,
	options: RemoteRunOptions,
): Promise<RemoteRunResult> {
	const { apiKey, endpoint, signal, callbacks } = options
	const sessionName = `acp-${randomUUID().slice(0, 8)}`
	const workspaceName = options.workspaceName ?? "kimchi"

	// The worker assigns a unique working directory when cwd is omitted:
	// /home/sandbox/<sessionName>. We mirror that same convention here so
	// the AcpSessionClient, sync, and post-completion handler all agree on
	// the path. We don't send cwd in the session request — letting the
	// worker own the path ensures consistency with its clone bootstrapper,
	// bridge cwd, and session config.
	//
	// We also strip targetDirectory from gitDetails: with the worker's
	// commit 57d4c6c, DirName is wired from TargetDirectory into the clone
	// bootstrapper, so sending it would nest (cwd/targetDirectory). With it
	// empty, the clone goes directly into the session's cwd — fresh clone
	// every time, no stale files from prior runs.
	const cwd = `/home/sandbox/${sessionName}`

	// 1. Authenticate
	const creds: WorkspaceCredentials = await authenticateWorkspace(workspaceId, apiKey, workspaceName, {
		endpoint,
		...(options.resources ? { resources: options.resources } : {}),
	})

	// 2. Wait for sandbox readiness
	await waitForWorkspaceReady({
		wsUrl: creds.wsUrl,
		connectToken: creds.connectToken,
		signal,
	})

	// 4. Connect via AcpSessionClient — always wrap onTextDelta so accumulated
	// text is captured even when the caller passes no callbacks.
	const wrappedCallbacks: AcpSessionCallbacks = {
		...callbacks,
		onTextDelta: (delta, fullText) => {
			st.responseText = fullText
			callbacks?.onTextDelta?.(delta, fullText)
		},
	}

	const client = new WorkerClient(creds)
	const acpClient = new AcpSessionClient({
		sessionName,
		credentials: creds,
		callbacks: wrappedCallbacks,
		signal,
		cwd,
	})

	// Mutable handles shared with the recovery engine — reauth/reattach swap
	// these in place so the poll loop and finally block always see the latest
	// client/creds. acpSessionId is captured from the first initialize so a
	// reattach can session/load the SAME session instead of starting a new one.
	const st: RemoteRecoveryState = {
		creds,
		client,
		acpClient,
		acpSessionId: undefined,
		responseText: "",
		recoveryNote: undefined,
		meta: {
			workspaceId,
			sessionName,
			wsUrl: creds.wsUrl,
			host: creds.host,
			cwd,
		},
		pollAuthRejected: false,
	}

	const backoffs = options.reconnectBackoffsMs ?? DEFAULT_RECONNECT_BACKOFFS_MS
	const turnSettleGraceMs = options.turnSettleGraceMs ?? DEFAULT_TURN_SETTLE_GRACE_MS
	const reviveDelayMs = backoffs[0] ?? 2_000
	const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
	const pollJitterMs = options.pollIntervalMs === undefined ? POLL_JITTER_MS : 0
	/** One status-poll delay: fixed interval + jitter (jitter dropped for the test seam). */
	const pollDelayMs = () => pollIntervalMs + Math.random() * pollJitterMs

	// Immutable config for the shared recovery engine (attachRemoteAgent is
	// the fresh-process entry point running the same engine).
	const config: RecoveryConfig = {
		sessionName,
		workspaceId,
		apiKey,
		workspaceName,
		endpoint,
		signal,
		outputFile: options.outputFile,
		cwd,
		onReady: options.onReady,
		onReconnecting: options.onReconnecting,
		backoffs,
		turnSettleGraceMs,
		reviveDelayMs,
		pollDelayMs,
		wrappedCallbacks,
	}

	// Provision git credentials on the worker BEFORE createSession — the clone
	// bootstrapper runs synchronously inside createSession and needs the token
	// available for private repos. Non-fatal: clone may still succeed for public repos.
	if (options.gitCredential) {
		try {
			await provisionGitCredential(
				client,
				{
					gitHost: options.gitCredential.host,
					gitToken: options.gitCredential.token,
				},
				signal,
			)
		} catch (err) {
			// Honor abort — don't continue to createSession if the user cancelled.
			if (err instanceof Error && err.name === "AbortError") throw err
			console.warn(
				`[remote-agent-runner] git credential provisioning failed: ${err instanceof Error ? err.message : err}`,
			)
		}
	}

	let stopReason = "end_turn"
	let usage: RemoteRunResult["usage"]
	let pollTimer: ReturnType<typeof setTimeout> | undefined
	let terminal = false
	// One-way: set when recovery begins, never reset (the run completes after
	// recovery). The recovery loop becomes the sole poller — the always-on
	// poller must not fire (or force-disconnect the fresh client) mid-recovery.
	let recovering = false

	// Always-on status poll: every ~15s + jitter, concurrent with `prompt()`.
	// Proactively detects disconnects by checking session status via HTTP
	// (separate from the WS connection). When it detects the connection is
	// broken (HTTP failure, clientConnected=false, or agent finished), it
	// forces the WS to disconnect so the hanging prompt() rejects with
	// RemoteConnectionError and the recovery state machine takes over.
	const pollStatus = async (): Promise<void> => {
		if (terminal || recovering || signal?.aborted) return
		let stop = false
		let shouldForceDisconnect = false
		let disconnectReason = ""
		try {
			const s = await getSession(client, sessionName, signal)
			if (!s.alive || (!s.agentRunning && s.finishedAt)) {
				stop = true
			}
			// The worker reports that no client is connected via WS — our WS
			// is dead but TCP hasn't noticed yet. Force disconnect to trigger
			// recovery immediately instead of waiting for a ping timeout.
			if (!s.clientConnected && !terminal) {
				shouldForceDisconnect = true
				disconnectReason = "worker reports client is disconnected"
			}
			// Agent finished while we were connected via poll but the WS may
			// still be hanging — force prompt() to reject so recovery runs.
			if (stop) {
				shouldForceDisconnect = true
				disconnectReason = "remote agent finished"
			}
		} catch (err) {
			if (signal?.aborted) return
			if (err instanceof WorkerError && err.status === 404) {
				stop = true
			}
			// HTTP poll failed (e.g. local network down). Do NOT force
			// disconnect — the WS ping keepalive owns transport-death
			// detection, and a poll failure says nothing about the WS.
		}
		// Recovery may have started while the poll was in flight — never
		// force-disconnect the freshly attached client or double-poll; the
		// recovery loop is the sole poller from here on.
		if (recovering) return
		if (shouldForceDisconnect) {
			acpClient.forceDisconnect(disconnectReason)
		}
		if (terminal || signal?.aborted || stop) return
		pollTimer = setTimeout(() => {
			void pollStatus().catch(() => {})
		}, pollDelayMs())
	}

	/**
	 * Mid-run disconnect recovery: the recovery loop becomes the sole poller
	 * (the always-on poller is stopped and barred — including any tick already
	 * in flight — from force-disconnecting the freshly attached client), then
	 * the shared recovery engine runs.
	 */
	const recoverFromDisconnect = async (): Promise<PromptOutcome> => {
		recovering = true
		if (pollTimer) clearTimeout(pollTimer)
		pollTimer = undefined
		return runRecovery(st, config)
	}

	// 3. Create ACP session + connect via AcpSessionClient.
	// The try/finally wraps createSession too so WorkerClient is cleaned up
	// even if createSession or acpClient.initialize throws.
	try {
		const sessionReq: { agentMode: "ACP"; yolo: true; details?: { git: RemoteRunOptions["gitDetails"] } } = {
			agentMode: "ACP",
			yolo: true,
		}
		if (options.gitDetails) {
			sessionReq.details = {
				git: {
					...options.gitDetails,
					// Omit targetDirectory so the worker clones directly into the
					// session's cwd (assigned by the worker as
					// /home/sandbox/<sessionName>). No nesting, fresh clone.
					targetDirectory: "",
				},
			}
		}
		const session = await createSession(client, sessionName, sessionReq, {
			signal,
			timeoutMs: SESSION_CREATE_TIMEOUT_MS,
		})

		// After the server-side clone, sync the local working-tree diff on top
		// so uncommitted changes and untracked files are available in the sandbox.
		// Non-fatal: the clone is already there, just some files may be stale.
		if (options.gitDetails && options.localPath) {
			await syncLocalChangesAfterClone({
				localPath: options.localPath,
				remotePath: cwd,
				remoteHost: creds.host,
				authToken: creds.connectToken,
				freshClone: session.freshClone ?? false,
				signal,
			})
		}

		// Start the status poll loop AFTER the WS is established. Starting it
		// before initialize() risks force-disconnecting a still-handshaking
		// client — the worker reports clientConnected=false until the first WS
		// connection completes, and a poll in that window would kill a healthy run.
		// Scheduling is wrapped so a throwing tick can never become an unhandled rejection.
		pollTimer = setTimeout(() => {
			void pollStatus().catch(() => {})
		}, pollDelayMs())

		await acpClient.initialize()
		st.acpSessionId ??= acpClient.sessionId ?? undefined

		// Expose the client to the caller so they can wrap it in RemoteAgentSession.
		// Fired after initialize() (client is usable) and before prompt() (the run hasn't started).
		if (options.onReady) {
			options.onReady(acpClient, st.meta)
		}

		// 5. Send prompt — recover from transient WS disconnects instead of failing.
		let promptResult: PromptOutcome
		try {
			promptResult = await acpClient.prompt(prompt)
		} catch (err) {
			if (err instanceof RemoteConnectionError) {
				promptResult = await recoverFromDisconnect()
			} else {
				// User abort (Ctrl+X) while still connected — the remote session
				// must not outlive its owner (spec Q5: abort deletes best-effort
				// even while disconnected). Non-abort errors never delete — the
				// session may still be inspectable.
				if (signal?.aborted) {
					await deleteSession(client, sessionName).catch(() => {})
				}
				throw err
			}
		}

		// The run is complete (or recovered) — stop the poller immediately so
		// no scheduled tick fires between prompt() resolving and the finally
		// block (e.g. during deleteSession).
		terminal = true
		stopReason = promptResult.stopReason
		usage = promptResult.usage

		// Success — the run is confirmed done; clean up the remote session.
		// (Deletion is deferred to here: error/abort paths above never delete.)
		// For recovered results, the session.jsonl has already been fetched
		// and parsed — safe to delete the remote session now.
		await deleteSession(st.client, sessionName).catch((err) => {
			console.error(`[remote-agent-runner] failed to delete session ${sessionName}:`, err)
		})

		return {
			responseText: st.responseText,
			stopReason,
			usage,
			remoteSession: st.meta,
			recoveryNote: st.recoveryNote,
		}
	} finally {
		terminal = true
		if (pollTimer) clearTimeout(pollTimer)
		st.acpClient?.close()
		await st.client.close().catch((err) => {
			console.error(`[remote-agent-runner] failed to close worker client:`, err)
		})
	}
}

// ---------------------------------------------------------------------------
// attachRemoteAgent — resume a remote run that outlived a kimchi restart
// ---------------------------------------------------------------------------

/** Options for attachRemoteAgent — attach to an EXISTING remote session. */
export interface AttachRemoteAgentOptions {
	/** Cloud API key for workspace authentication. */
	apiKey: string
	/** Override the cloud API endpoint (used by tests). */
	endpoint?: string
	/** Abort signal — aborts the remote session (user kill). */
	signal?: AbortSignal
	/** The remote session to attach to (persisted at dispatch time). */
	remoteSession: RemoteSessionMeta
	/** The ACP session id captured when the run started — session/load
	 *  attaches by id, never by name; without it the run cannot be resumed. */
	acpSessionId: string
	/** Workspace name passed to authenticateWorkspace (matching/reuse). */
	workspaceName?: string
	/** Local output file path for transcript backfill during recovery. */
	outputFile?: string
	/** Fired when the engine attaches to the live session — the caller can
	 *  rebind its session adapter to the new client (same as onReady in
	 *  RemoteRunOptions). */
	onReady?: (acpClient: AcpSessionClient, meta: RemoteSessionMeta) => void
	/** Called when the attach transitions between reconnecting/attached —
	 *  the caller mirrors it onto the agent record status. */
	onReconnecting?: (reconnecting: boolean) => void
	/** Event callbacks — same shape as RemoteRunOptions callbacks. */
	callbacks?: AcpSessionCallbacks
	/** Test seams — same meaning as in RemoteRunOptions. */
	reconnectBackoffsMs?: number[]
	turnSettleGraceMs?: number
	pollIntervalMs?: number
}

/**
 * Attaches to a remote run that outlived a kimchi restart — the fresh-process
 * entry point of the SHARED recovery engine (the same poll/reattach/replay
 * state machine the mid-run disconnect recovery runs; a fresh attach enters
 * with identical initial conditions: not attached, no live WS, known
 * acpSessionId). The remote session kept running while kimchi was closed
 * (shutdown spares remote runs); this never re-sends the prompt — it attaches
 * to the EXISTING session via session/load and recovers the result from the
 * session replay once the turn has finished.
 *
 * Outcomes mirror the reconnect loop: `recovered` (result replayed) or
 * `recovery_failed` (result unknown — e.g. the replay held no final message).
 * A reaped session (404), an unrevivable sandbox, or a user kill throws,
 * exactly like the mid-run path (the kill also best-effort deletes the
 * remote session).
 */
export async function attachRemoteAgent(options: AttachRemoteAgentOptions): Promise<RemoteRunResult> {
	const { apiKey, endpoint, signal, remoteSession, acpSessionId } = options
	const workspaceName = options.workspaceName ?? "kimchi"
	const backoffs = options.reconnectBackoffsMs ?? DEFAULT_RECONNECT_BACKOFFS_MS
	const turnSettleGraceMs = options.turnSettleGraceMs ?? DEFAULT_TURN_SETTLE_GRACE_MS
	const reviveDelayMs = backoffs[0] ?? 2_000
	const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
	const pollJitterMs = options.pollIntervalMs === undefined ? POLL_JITTER_MS : 0
	const pollDelayMs = () => pollIntervalMs + Math.random() * pollJitterMs

	// Authenticate against the persisted workspace — creds never survive a
	// restart (connect tokens expire), so this always starts with a fresh one.
	const creds: WorkspaceCredentials = await authenticateWorkspace(remoteSession.workspaceId, apiKey, workspaceName, {
		endpoint,
	})

	const st: RemoteRecoveryState = {
		creds,
		client: new WorkerClient(creds),
		// Fresh-process attach: no client yet — the engine constructs one on
		// the first reattach.
		acpClient: undefined,
		acpSessionId,
		responseText: "",
		recoveryNote: undefined,
		// The persisted wsUrl/host may be stale — re-sync to the fresh creds.
		meta: {
			...remoteSession,
			wsUrl: creds.wsUrl,
			host: creds.host,
		},
		pollAuthRejected: false,
	}
	const wrappedCallbacks: AcpSessionCallbacks = {
		...options.callbacks,
		onTextDelta: (delta, fullText) => {
			st.responseText = fullText
			options.callbacks?.onTextDelta?.(delta, fullText)
		},
	}
	const config: RecoveryConfig = {
		sessionName: remoteSession.sessionName,
		workspaceId: remoteSession.workspaceId,
		apiKey,
		workspaceName,
		endpoint,
		signal,
		outputFile: options.outputFile,
		cwd: remoteSession.cwd,
		onReady: options.onReady,
		onReconnecting: options.onReconnecting,
		backoffs,
		turnSettleGraceMs,
		reviveDelayMs,
		pollDelayMs,
		wrappedCallbacks,
	}

	try {
		const outcome = await runRecovery(st, config)
		// The run is confirmed done (or its outcome is definitively unknown) —
		// clean up the remote session. Same deferred-deletion contract as the
		// main flow: only a resolved outcome deletes; throws (reaped session,
		// unrevivable sandbox, user kill) never reach here — the kill path does
		// its own best-effort delete inside runRecovery.
		await deleteSession(st.client, config.sessionName).catch((err) => {
			console.error(`[remote-agent-runner] failed to delete session ${config.sessionName}:`, err)
		})
		return {
			responseText: st.responseText,
			stopReason: outcome.stopReason,
			usage: outcome.usage,
			remoteSession: st.meta,
			recoveryNote: st.recoveryNote,
		}
	} finally {
		st.acpClient?.close()
		await st.client.close().catch((err) => {
			console.error(`[remote-agent-runner] failed to close worker client:`, err)
		})
	}
}

/**
 * Best-effort ownership check for a fresh-process resume: reports whether
 * another client currently holds a live WebSocket on the remote session.
 * Returns true only on a POSITIVE sighting (clientConnected on a successful
 * status poll) — any failure returns false so the caller falls through to the
 * attach, whose recovery machinery handles the real session state.
 */
export async function isRemoteSessionConnected(
	remoteSession: RemoteSessionMeta,
	apiKey: string,
	options?: { endpoint?: string },
): Promise<boolean> {
	try {
		const creds = await authenticateWorkspace(remoteSession.workspaceId, apiKey, "kimchi", {
			endpoint: options?.endpoint,
		})
		const client = new WorkerClient(creds)
		try {
			const status = await getSession(client, remoteSession.sessionName, undefined)
			return status.clientConnected
		} finally {
			await client.close().catch(() => {})
		}
	} catch {
		return false
	}
}
