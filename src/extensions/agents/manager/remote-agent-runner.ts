/**
 * runRemoteAgent — the cloud equivalent of `runAgent()`.
 *
 * Authenticates to a workspace, creates an ACP session on the sandbox worker,
 * connects via `AcpSessionClient`, sends a prompt, and returns the result.
 *
 * Designed to be reusable: when a `remote: true` agent type is registered
 * (Task 4+5 from the plan), `AgentManager.startAgent()` can call this function
 * instead of `runAgent()`.
 */

import { randomUUID } from "node:crypto"
import { authenticateWorkspace } from "../../../sandbox/cloud/auth.js"
import { waitForWorkspaceReady } from "../../../sandbox/cloud/readiness.js"
import type { WorkspaceCredentials } from "../../../sandbox/cloud/types.js"
import { type AcpSessionCallbacks, AcpSessionClient } from "../../../sandbox/worker/acp-client.js"
import { WorkerClient } from "../../../sandbox/worker/client.js"
import { createSession, deleteSession } from "../../../sandbox/worker/sessions.js"
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
	/** Workspace name passed to authenticateWorkspace (used for matching/reuse). */
	workspaceName?: string
	/**
	 * Called after `acpClient.initialize()` and before `acpClient.prompt()`,
	 * giving the caller access to the live AcpSessionClient so it can be
	 * wrapped in a RemoteAgentSession adapter.
	 */
	onReady?: (acpClient: AcpSessionClient, meta: RemoteSessionMeta) => void
}

export interface RemoteRunResult {
	/** The assistant's full response text. */
	responseText: string
	/** Why the prompt stopped. */
	stopReason: string
	/** Token usage for the turn (if reported by the agent). */
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
	/** Remote session metadata for reconnection/steer/resume/sync. */
	remoteSession: RemoteSessionMeta
}

/** Per-call timeout for createSession: 5min — large repos take a while to clone. */
const SESSION_CREATE_TIMEOUT_MS = 5 * 60_000

/**
 * Runs a single-turn prompt on a remote sandbox worker via ACP.
 *
 * 1. Authenticates to the workspace (auto-resolves or creates one)
 * 2. Waits for the sandbox to be ready
 * 3. Creates an ACP session with `yolo: true`
 * 4. Connects via `AcpSessionClient`
 * 5. Sends the prompt and collects the response
 * 6. Returns `RemoteRunResult` with response text and session metadata
 */
export async function runRemoteAgent(
	workspaceId: string,
	prompt: string,
	options: RemoteRunOptions,
): Promise<RemoteRunResult> {
	const { apiKey, endpoint, signal, callbacks } = options
	const sessionName = `acp-${randomUUID().slice(0, 8)}`

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
	const creds: WorkspaceCredentials = await authenticateWorkspace(
		workspaceId,
		apiKey,
		options.workspaceName ?? "kimchi",
		{ endpoint },
	)

	// 2. Wait for sandbox readiness
	await waitForWorkspaceReady({
		wsUrl: creds.wsUrl,
		connectToken: creds.connectToken,
		signal,
	})

	// 4. Connect via AcpSessionClient — always wrap onTextDelta so accumulated
	// text is captured even when the caller passes no callbacks.
	let responseText = ""
	const wrappedCallbacks: AcpSessionCallbacks = {
		...callbacks,
		onTextDelta: (delta, fullText) => {
			responseText = fullText
			callbacks?.onTextDelta?.(delta, fullText)
		},
	}

	// 3. Create ACP session + connect via AcpSessionClient.
	// The try/finally wraps createSession too so WorkerClient is cleaned up
	// even if createSession or acpClient.initialize throws.
	const client = new WorkerClient(creds)
	const acpClient = new AcpSessionClient({
		sessionName,
		credentials: creds,
		callbacks: wrappedCallbacks,
		signal,
		cwd,
	})

	let stopReason = "end_turn"

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

		await acpClient.initialize()

		// Expose the client to the caller so they can wrap it in RemoteAgentSession.
		// Fired after initialize() (client is usable) and before prompt() (the run hasn't started).
		if (options.onReady) {
			options.onReady(acpClient, {
				workspaceId,
				sessionName,
				wsUrl: creds.wsUrl,
				host: creds.host,
				cwd,
			})
		}

		// 5. Send prompt
		const result = await acpClient.prompt(prompt)
		stopReason = result.stopReason

		return {
			responseText,
			stopReason,
			usage: result.usage,
			remoteSession: {
				workspaceId,
				sessionName,
				wsUrl: creds.wsUrl,
				host: creds.host,
				cwd,
			},
		}
	} finally {
		acpClient.close()
		await deleteSession(client, sessionName).catch((err) => {
			console.error(`[remote-agent-runner] failed to delete session ${sessionName}:`, err)
		})
		await client.close().catch((err) => {
			console.error(`[remote-agent-runner] failed to close worker client:`, err)
		})
	}
}
