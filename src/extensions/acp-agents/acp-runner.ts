/**
 * acp-runner.ts — runs an ACP external agent as a subagent-plane node.
 *
 * Mirrors `_runRemote()` in AgentManager: resolves the server config, drives
 * an ACP client (stdio child process, or WebSocket reusing the sandbox
 * client) through the turn loop, maps `AcpSessionCallbacks` onto the spawn
 * callbacks, and returns an `AcpRunResult`. One `prompt()` call is one
 * turn; steers and pending peer messages are delivered as follow-up prompts
 * between turns (see the drain hook in the loop).
 *
 * v1 limitations (documented in docs/acp-agents.md):
 * - `steered` stays false: ACP records never enter the in-process `steered`
 *   terminal status; steer-equivalents are delivered as prompts and the
 *   record completes normally.
 * - Transcript files for ACP agents hold the initial entry and the final
 *   result only — there is no in-process session to subscribe to.
 * - WS transport is deny-permissions-only (the sandbox client rejects all
 *   permission requests unconditionally).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { type AcpPromptResult, type AcpSessionCallbacks, AcpSessionClient } from "../../sandbox/worker/acp-client.js"
import { getAgentInvocation } from "../../utils/spawn-kimchi-subprocess.js"
import { getActiveManager } from "../agents/index.js"
import type { AcpRunResult, PendingAgentMessage, SpawnOptions } from "../agents/manager/agent-manager.js"
import { addUsage, type LifetimeUsage } from "../agents/manager/usage.js"
import type { AgentAbortReason, AgentRecord } from "../agents/personas/types.js"
import { type AcpMcpServer, StdioAcpClient } from "./acp-agent-client.js"
import { getAgentCommsIpc } from "./comms-ipc.js"
import { type AcpAgentServerConfig, loadAcpAgentServers } from "./config.js"

/** The client surface both transports expose to the runner. */
interface AcpClientSurface {
	initialize(): Promise<void>
	prompt(text: string): Promise<AcpPromptResult>
	cancel(): Promise<void>
	close(): void
	/** Best-effort model selection via the experimental session/set_model. */
	setModel?(model: string): Promise<void>
}

/** Far-future expiry for synthesized WS credentials (the field is required but unused by the client). */
const SYNTHETIC_EXPIRES_AT = "2999-01-01T00:00:00.000Z"

/** How long the ACP runner waits for a parent reply to an open question
 *  thread before giving up (the thread stays open for a later reply). */
const PARENT_REPLY_WAIT_MS = 120_000

/** Poll interval while waiting for a parent reply. */
const PARENT_REPLY_POLL_MS = 1_000

function hostFromUrl(url: string): string {
	try {
		return new URL(url).host
	} catch {
		return "unknown"
	}
}

function buildAcpClient(
	config: AcpAgentServerConfig,
	record: AgentRecord,
	ctx: ExtensionContext,
	callbacks: AcpSessionCallbacks,
	mcpServers: AcpMcpServer[],
): AcpClientSurface {
	if (config.transport === "stdio") {
		if (!config.command) throw new Error(`ACP server "${config.name}" is missing its command.`)
		return new StdioAcpClient({
			command: config.command,
			args: config.args,
			env: config.env,
			cwd: config.cwd ?? ctx.cwd,
			callbacks,
			signal: record.abortController?.signal,
			mcpServers,
			permissions: config.permissions,
		})
	}
	if (!config.url) throw new Error(`ACP server "${config.name}" is missing its url.`)
	return new AcpSessionClient({
		sessionName: config.sessionName ?? `acp-${record.id.slice(0, 8)}`,
		credentials: {
			wsUrl: config.url,
			connectToken: config.token ?? "",
			host: hostFromUrl(config.url),
			expiresAt: SYNTHETIC_EXPIRES_AT,
		},
		cwd: ctx.cwd,
		callbacks,
		signal: record.abortController?.signal,
		mcpServers,
	})
}

/**
 * Runs one ACP external agent to completion. Called by AgentManager._runAcp
 * via the setAcpRunner injection (acp-agents extension).
 */
export async function runAcpAgent(
	record: AgentRecord,
	prompt: string,
	options: SpawnOptions,
	ctx: ExtensionContext,
): Promise<AcpRunResult> {
	const serverName = record.acp?.server
	if (!serverName) throw new Error("ACP run requires record.acp.server.")
	const config = loadAcpAgentServers(ctx.cwd).get(serverName)
	if (!config) {
		throw new Error(
			`ACP agent server "${serverName}" is no longer configured (checked .kimchi/acp-agents.json and the global config).`,
		)
	}

	// MCP servers handed to the external agent in newSession. When
	// communication is enabled, the host comms shim (board + messaging) is
	// passed so the external agent can call the same tools as in-process
	// peers — through host-authorized IPC, never by trusting model input.
	// Token revocation is manager-owned (transitionToTerminalRecord).
	const mcpServers: AcpMcpServer[] = []
	if (record.communication && record.communicationScope) {
		const ipc = getAgentCommsIpc()
		const socketPath = ipc.ensureStarted()
		const token = ipc.registerToken(record.id)
		mcpServers.push({ name: "kimchi-agent-comms", ...getAgentInvocation(["--agent-comms-mcp", socketPath, token]) })
	}

	let turnText = ""
	let responseText = ""
	const callbacks: AcpSessionCallbacks = {
		onTextDelta: (delta, fullText) => {
			turnText = fullText
			options.onTextDelta?.(delta, fullText)
		},
		onToolActivity: (activity) => {
			if (activity.status === "completed" || activity.status === "failed") record.toolUses++
			options.onToolActivity?.(activity)
		},
		onTurnEnd: (turnCount) => {
			record.lastTurnCount = turnCount
			options.onTurnEnd?.(turnCount)
		},
		onAssistantUsage: (usage: LifetimeUsage) => {
			addUsage(record.lifetimeUsage, usage)
			options.onAssistantUsage?.(usage)
		},
		onRawNotification: (params) => options.onRawNotification?.(params),
	}

	// Retry transient spawn failures (e.g. Gemini CLI's intermittent "Internal
	// Error" on first launch). Max 2 retries (3 total attempts); config errors
	// and aborts are not retried.
	const MAX_INITIALIZE_ATTEMPTS = 3
	let client: AcpClientSurface | undefined
	let initializeError: unknown
	for (let attempt = 1; attempt <= MAX_INITIALIZE_ATTEMPTS; attempt++) {
		const retryClient = buildAcpClient(config, record, ctx, callbacks, mcpServers)
		try {
			await retryClient.initialize()
			client = retryClient
			initializeError = undefined
			break
		} catch (err) {
			retryClient.close()
			if (record.abortController?.signal.aborted) throw err
			initializeError = err
			if (attempt < MAX_INITIALIZE_ATTEMPTS) {
				// Brief pause between attempts — transient startup races often settle.
				await new Promise((r) => setTimeout(r, 500 * attempt))
			}
		}
	}
	if (!client) {
		throw initializeError instanceof Error ? initializeError : new Error(String(initializeError))
	}
	let abortReason: AgentAbortReason | undefined
	let durationTimer: ReturnType<typeof setTimeout> | undefined

	try {
		await client.initialize()

		// default_model from the server config: applied right after initialize
		// so the session exists. Non-fatal — servers without session/set_model
		// support (or an unknown model id) must not kill the run.
		if (config.defaultModel && client.setModel) {
			try {
				await client.setModel(config.defaultModel)
			} catch {
				// best effort only — the run continues on the server's default model
			}
		}

		// maxDuration enforcement (seconds): cancel the in-flight turn; the
		// client's prompt stall timeout is the backstop for agents that ignore
		// session/cancel.
		const maxDuration = options.maxDuration
		if (maxDuration != null && maxDuration > 0) {
			durationTimer = setTimeout(() => {
				abortReason = "max_duration"
				client.cancel().catch(() => {})
			}, maxDuration * 1000)
			durationTimer.unref?.()
		}

		let turnsUsed = 0
		let cancelled = false

		// Turn loop: the initial prompt, then steers and pending peer messages
		// delivered as follow-up prompts through the manager's ACP drain —
		// steers first (orchestrator directives, combined), then broker
		// messages. Follow-ups are only taken while the turn budget allows
		// another turn; undelivered work stays queued and is terminalized by the
		// record's terminal transition (never silently dropped).
		let next: { prompt: string; pending?: PendingAgentMessage } | undefined = { prompt }
		while (next !== undefined) {
			const result = await client.prompt(next.prompt)
			turnsUsed++
			if (result.stopReason === "cancelled") cancelled = true
			if (turnText.trim()) responseText = turnText
			turnText = ""
			const manager = getActiveManager()
			manager?.completeAcpFollowUp(next.pending)
			next = options.maxTurns != null && turnsUsed >= options.maxTurns ? undefined : manager?.takeAcpFollowUp(record.id)
		}

		// Parent-reply wait: the agent asked the user a question and is
		// waiting for the parent's answer. Stay alive so the reply can be
		// delivered as a follow-up turn instead of hitting thread_closed.
		// Poll takeAcpFollowUp — the reply is queued as a pending message
		// by replyToAgentMessage when the target is running and session-less.
		const replyDeadline = Date.now() + PARENT_REPLY_WAIT_MS
		while (Date.now() < replyDeadline) {
			const manager = getActiveManager()
			if (!manager) break
			if (record.abortController?.signal.aborted) break
			// Drain the queue FIRST: a queued reply closes the question thread
			// at reservation time (closeThreadForAnswer), so checking
			// hasOpenQuestionThreads before draining would break the loop
			// exactly when the answer we are waiting for just arrived.
			const reply = manager.takeAcpFollowUp(record.id)
			if (reply) {
				const result = await client.prompt(reply.prompt)
				turnsUsed++
				if (result.stopReason === "cancelled") cancelled = true
				if (turnText.trim()) responseText = turnText
				turnText = ""
				manager.completeAcpFollowUp(reply.pending)
				continue
			}
			// No reply queued — keep waiting only while a question thread is
			// still open (the agent may ask again after a follow-up turn).
			if (!manager.hasOpenQuestionThreads(record.id)) break
			await new Promise((r) => setTimeout(r, PARENT_REPLY_POLL_MS))
		}

		return {
			responseText,
			session: undefined,
			aborted: abortReason !== undefined || cancelled,
			abortReason,
			steered: false,
			turnsUsed,
			maxTurns: options.maxTurns,
		}
	} finally {
		if (durationTimer) clearTimeout(durationTimer)
		client.close()
	}
}
