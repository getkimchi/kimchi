/**
 * A2A client — talk to another session's inbox server.
 *
 * sendMessage() posts `message/send` and polls `tasks/get` until the task
 * reaches a terminal state (or the caller's timeout fires). The peer's reply
 * text is extracted from the task history.
 */

import type { AgentCard, TaskRecord, TaskState } from "./a2a-server.js"
import { replyFromTask } from "./a2a-server.js"

const TERMINAL_STATES: TaskState[] = ["completed", "failed", "canceled"]
const POLL_INTERVAL_MS = 500

export function inboxUrl(port: number): string {
	return `http://127.0.0.1:${port}/`
}

export function cardUrl(port: number): string {
	return `http://127.0.0.1:${port}/.well-known/agent-card.json`
}

export async function fetchAgentCard(port: number, timeoutMs = 5000): Promise<AgentCard> {
	const res = await fetch(cardUrl(port), { signal: AbortSignal.timeout(timeoutMs) })
	if (!res.ok) throw new Error(`Agent card fetch failed: HTTP ${res.status}`)
	return (await res.json()) as AgentCard
}

export interface SendOptions {
	token: string
	fromName?: string
	fromSessionId?: string
	notifyWhenIdle?: boolean
	/**
	 * False = fire-and-forget (message_peer): the peer's task completes at
	 * injection; no reply is awaited. Default true (ask_peer).
	 */
	expectReply?: boolean
	/** Overall budget for send + poll. */
	timeoutMs?: number
}

export interface SendResult {
	taskId: string
	state: TaskState
	/** Peer's reply text (completed tasks). */
	reply?: string
	/** Failure/cancel reason when not completed. */
	reason?: string
}

function extractInboundText(payload: unknown): string {
	// task.history / status.message are plain text; errors surface as strings.
	if (typeof payload === "string") return payload
	return ""
}

export async function sendMessage(port: number, text: string, opts: SendOptions): Promise<SendResult> {
	const timeoutMs = opts.timeoutMs ?? 120_000
	const deadline = Date.now() + timeoutMs

	const post = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
		const res = await fetch(inboxUrl(port), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${opts.token}`,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: `c-${Date.now()}-${Math.random().toString(36).slice(2)}`,
				method,
				params,
			}),
			signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
		})
		const body = (await res.json()) as Record<string, unknown>
		if (body.error) {
			const err = body.error as { code: number; message: string }
			throw new Error(`Peer refused (${err.code}): ${err.message}`)
		}
		return body
	}

	const initialBody = await post("message/send", {
		message: {
			role: "user",
			parts: [{ kind: "text", text }],
			metadata: {
				fromName: opts.fromName,
				fromSessionId: opts.fromSessionId,
				notifyWhenIdle: opts.notifyWhenIdle === true || undefined,
				expectReply: opts.expectReply === false ? false : undefined,
			},
		},
	})
	let task = (initialBody.result ?? initialBody) as unknown as TaskRecord

	while (!TERMINAL_STATES.includes(task.status.state)) {
		if (Date.now() >= deadline) {
			// Best-effort cancel so the peer's inflight slot frees up.
			try {
				await post("tasks/cancel", { id: task.id })
			} catch {
				// Cancel failure must not mask the timeout.
			}
			throw new Error(`Peer did not answer within ${Math.round(timeoutMs / 1000)}s (task ${task.id} canceled).`)
		}
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
		const pollBody = await post("tasks/get", { id: task.id })
		task = (pollBody.result ?? pollBody) as unknown as TaskRecord
	}

	if (task.status.state === "completed") {
		return {
			taskId: task.id,
			state: "completed",
			reply: replyFromTask(task) ?? extractInboundText(task.status.message),
		}
	}
	return { taskId: task.id, state: task.status.state, reason: task.status.message ?? task.status.state }
}
