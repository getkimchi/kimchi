/**
 * Minimal A2A-compatible inbox server.
 *
 * Implements the A2A v1.0 JSON-RPC surface a local peer actually needs:
 *
 *   GET  /.well-known/agent-card.json   — discovery card (no auth)
 *   POST /  message/send                — deliver a text message, create a task
 *   POST /  tasks/get                   — poll task state
 *   POST /  tasks/cancel                — cancel a task
 *
 * Design notes:
 * - Pure request handler (`handleA2aRequest`) separated from the HTTP listener
 *   so the whole protocol is testable without sockets.
 * - Delivery is an injected async callback — this module never imports pi.
 * - Abuse resistance (Claude Code learnings): text size cap, burst cap,
 *   per-sender identical-repeat dedupe, in-flight cap, self-send refusal.
 *   Agent-to-agent message loops therefore die on their own.
 * - Auth: `Authorization: Bearer <token>` is mandatory on every RPC POST.
 */

import { createHash, randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"

export const MAX_TEXT_CHARS = 200_000
export const MAX_INFLIGHT_TASKS = 5
export const BURST_WINDOW_MS = 10_000
export const BURST_MAX = 20
export const DEDUPE_WINDOW_MS = 3_000
export const SETTLE_TIMEOUT_MS = 10 * 60_000

export interface AgentCard {
	name: string
	description: string
	url: string
	protocolVersion: string
	version: string
	capabilities: { streaming: boolean; pushNotifications: boolean }
	defaultInputModes: string[]
	defaultOutputModes: string[]
	skills: Array<{ id: string; name: string; description: string }>
	securitySchemes: Record<string, { type: string; scheme: string }>
	security: Array<{ bearer: string[] }>
}

export interface PeerSender {
	name?: string
	sessionId?: string
}

export interface DeliverMeta {
	notifyWhenIdle?: boolean
	/**
	 * True when the sender blocks on a reply (ask_peer): the injected message
	 * may wake an idle agent and the task completes with the reply text.
	 * False (message_peer): transport-level delivery — the task completes at
	 * injection ("delivered" = 200 OK); the message is queued discreetly and
	 * the receiving agent is never woken just to acknowledge it.
	 */
	expectReply?: boolean
}

export type DeliverFn = (text: string, from: PeerSender, meta: DeliverMeta) => Promise<string>

export type TaskState = "submitted" | "working" | "completed" | "failed" | "canceled"

export interface TaskRecord {
	id: string
	contextId: string
	status: { state: TaskState; message?: string }
	history: Array<{ role: string; parts: Array<{ kind: string; text: string }> }>
	createdAt: number
	settledAt?: number
}

export interface A2aState {
	card: AgentCard
	token: string
	deliver: DeliverFn
	tasks: Map<string, TaskRecord>
	inflightCount: number
	burst: { windowStart: number; count: number }
	recentSends: Map<string, number>
}

export function createA2aState(opts: { card: AgentCard; token: string; deliver: DeliverFn }): A2aState {
	return {
		card: opts.card,
		token: opts.token,
		deliver: opts.deliver,
		tasks: new Map(),
		inflightCount: 0,
		burst: { windowStart: 0, count: 0 },
		recentSends: new Map(),
	}
}

interface RpcRequest {
	jsonrpc?: string
	id?: unknown
	method?: unknown
	params?: Record<string, unknown>
}

interface RpcResponse {
	status: number
	body: unknown
}

function rpcResult(id: unknown, result: unknown): RpcResponse {
	return { status: 200, body: { jsonrpc: "2.0", id, result } }
}

function rpcError(id: unknown, code: number, message: string): RpcResponse {
	return { status: 200, body: { jsonrpc: "2.0", id, error: { code, message } } }
}

export const ERR_PARSE = -32700
export const ERR_INVALID_REQUEST = -32600
export const ERR_METHOD_NOT_FOUND = -32601
export const ERR_INVALID_PARAMS = -32602
export const ERR_TASK_NOT_FOUND = -32001
export const ERR_RATE_LIMITED = -32029

function extractText(params: Record<string, unknown>): string | undefined {
	const message = params.message as Record<string, unknown> | undefined
	if (!message) return undefined
	const parts = message.parts as Array<Record<string, unknown>> | undefined
	if (!Array.isArray(parts)) return undefined
	const texts: string[] = []
	for (const part of parts) {
		const kind = part.kind ?? part.type
		if ((kind === "text" || kind === "Text") && typeof part.text === "string") {
			texts.push(part.text)
		}
	}
	return texts.join("\n")
}

function extractSender(params: Record<string, unknown>): PeerSender {
	const message = params.message as Record<string, unknown> | undefined
	const metadata = message?.metadata as Record<string, unknown> | undefined
	if (!metadata) return {}
	return {
		name: typeof metadata.fromName === "string" ? metadata.fromName : undefined,
		sessionId: typeof metadata.fromSessionId === "string" ? metadata.fromSessionId : undefined,
	}
}

function extractMeta(params: Record<string, unknown>): DeliverMeta {
	const message = params.message as Record<string, unknown> | undefined
	const metadata = message?.metadata as Record<string, unknown> | undefined
	return {
		notifyWhenIdle: metadata?.notifyWhenIdle === true,
		// Default true: an absent flag means the sender wants a reply (ask).
		expectReply: metadata?.expectReply !== false,
	}
}

function agentReply(task: TaskRecord): string | undefined {
	for (let i = task.history.length - 1; i >= 0; i--) {
		const entry = task.history[i]
		if (entry.role === "agent") {
			return entry.parts.map((p) => p.text).join("\n")
		}
	}
	return undefined
}

function settleTask(state: A2aState, task: TaskRecord, stateName: TaskState, message?: string): void {
	if (task.status.state === "working" || task.status.state === "submitted") {
		task.status = { state: stateName, message }
		task.settledAt = Date.now()
		state.inflightCount = Math.max(0, state.inflightCount - 1)
	}
}

function makeTask(state: A2aState, contextId: string): TaskRecord {
	const task: TaskRecord = {
		id: `task-${randomBytes(6).toString("hex")}`,
		contextId,
		status: { state: "working" },
		history: [],
		createdAt: Date.now(),
	}
	state.tasks.set(task.id, task)
	state.inflightCount += 1
	// Settle fail-safe: a hung deliver must not leak an in-flight slot forever.
	const timer = setInterval(() => {
		if (task.status.state === "working" || task.status.state === "submitted") {
			settleTask(state, task, "failed", "(delivery timed out)")
		}
	}, SETTLE_TIMEOUT_MS)
	timer.unref?.()
	return task
}

function checkBurst(state: A2aState): boolean {
	const now = Date.now()
	if (now - state.burst.windowStart > BURST_WINDOW_MS) {
		state.burst = { windowStart: now, count: 0 }
	}
	state.burst.count += 1
	return state.burst.count <= BURST_MAX
}

function checkDedupe(state: A2aState, from: PeerSender, text: string): boolean {
	const key = createHash("sha256")
		.update(`${from.name ?? ""}\u0000${text}`)
		.digest("hex")
	const now = Date.now()
	const last = state.recentSends.get(key)
	if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return false
	// Prune old keys occasionally to bound memory.
	if (state.recentSends.size > 500) {
		for (const [k, ts] of state.recentSends) {
			if (now - ts > DEDUPE_WINDOW_MS) state.recentSends.delete(k)
		}
	}
	state.recentSends.set(key, now)
	return true
}

/**
 * Handle one HTTP request against the A2A state. Returns the HTTP status and
 * JSON body to write back. Pure aside from state mutation.
 */
export function handleA2aRequest(
	state: A2aState,
	input: { httpMethod: string; path: string; authHeader?: string; rawBody?: string },
): RpcResponse {
	// Discovery card: unauthenticated by design.
	if (input.httpMethod === "GET" && input.path === "/.well-known/agent-card.json") {
		return { status: 200, body: state.card }
	}
	if (input.httpMethod !== "POST" || input.path !== "/") {
		return { status: 404, body: { error: "not found" } }
	}

	// Mandatory bearer token.
	const expected = `Bearer ${state.token}`
	if (input.authHeader !== expected) {
		return { status: 401, body: { error: "unauthorized" } }
	}

	// Size cap before parsing.
	if (input.rawBody !== undefined && input.rawBody.length > MAX_TEXT_CHARS + 65_536) {
		return rpcError(null, ERR_INVALID_PARAMS, `Message too large (cap ${MAX_TEXT_CHARS} chars).`)
	}

	let req: RpcRequest
	try {
		req = JSON.parse(input.rawBody ?? "") as RpcRequest
	} catch {
		return rpcError(null, ERR_PARSE, "Invalid JSON.")
	}
	if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
		return rpcError(req.id, ERR_INVALID_REQUEST, "Not a JSON-RPC 2.0 request.")
	}
	const params = req.params ?? {}

	switch (req.method) {
		case "message/send": {
			const text = extractText(params)
			if (text === undefined || text.length === 0) {
				return rpcError(req.id, ERR_INVALID_PARAMS, "message.send requires message.parts with a text part.")
			}
			const from = extractSender(params)
			if (from.name && from.name === state.card.name) {
				return rpcError(req.id, ERR_INVALID_PARAMS, "A session cannot message itself.")
			}
			if (text.length > MAX_TEXT_CHARS) {
				return rpcError(req.id, ERR_INVALID_PARAMS, `Message too large (cap ${MAX_TEXT_CHARS} chars).`)
			}
			if (!checkBurst(state)) {
				return rpcError(req.id, ERR_RATE_LIMITED, "Too many messages to this session right now — batch or wait.")
			}
			if (!checkDedupe(state, from, text)) {
				return rpcError(req.id, ERR_RATE_LIMITED, "Duplicate message within the dedupe window.")
			}
			if (state.inflightCount >= MAX_INFLIGHT_TASKS) {
				return rpcError(req.id, ERR_RATE_LIMITED, "This session's inbox is busy — retry shortly.")
			}
			const task = makeTask(state, from.sessionId ?? "default")
			void (async () => {
				try {
					const reply = await state.deliver(text, from, extractMeta(params))
					task.history.push({ role: "agent", parts: [{ kind: "text", text: reply }] })
					settleTask(state, task, "completed")
				} catch (err) {
					const messageText = err instanceof Error ? err.message : String(err)
					settleTask(state, task, "failed", messageText)
				}
			})()
			return rpcResult(req.id, task)
		}
		case "tasks/get": {
			const id = typeof params.id === "string" ? params.id : undefined
			const task = id ? state.tasks.get(id) : undefined
			if (!task) return rpcError(req.id, ERR_TASK_NOT_FOUND, "Task not found.")
			return rpcResult(req.id, task)
		}
		case "tasks/cancel": {
			const id = typeof params.id === "string" ? params.id : undefined
			const task = id ? state.tasks.get(id) : undefined
			if (!task) return rpcError(req.id, ERR_TASK_NOT_FOUND, "Task not found.")
			settleTask(state, task, "canceled", "canceled by requester")
			return rpcResult(req.id, task)
		}
		default:
			return rpcError(req.id, ERR_METHOD_NOT_FOUND, `Unknown method: ${req.method}`)
	}
}

/** Agent reply text from a settled task (client-side helper). */
export function replyFromTask(task: TaskRecord): string | undefined {
	return agentReply(task)
}

/** Start the loopback HTTP listener. Resolves with the bound port. */
export function startA2aServer(opts: {
	card: AgentCard
	token: string
	deliver: DeliverFn
	host?: string
	port?: number
}): Promise<{ port: number; stop: () => Promise<void> }> {
	const state = createA2aState(opts)
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = []
		req.on("data", (chunk: Buffer) => chunks.push(chunk))
		req.on("end", () => {
			let response: RpcResponse
			try {
				response = handleA2aRequest(state, {
					httpMethod: req.method ?? "GET",
					path: req.url ?? "/",
					authHeader: req.headers.authorization,
					rawBody: Buffer.concat(chunks).toString("utf8"),
				})
			} catch (err) {
				response = rpcError(null, ERR_INVALID_REQUEST, err instanceof Error ? err.message : String(err))
			}
			res.writeHead(response.status, { "Content-Type": "application/json" })
			res.end(JSON.stringify(response.body))
		})
	})
	const host = opts.host ?? "127.0.0.1"
	return new Promise((resolvePromise, rejectPromise) => {
		server.once("error", rejectPromise)
		server.listen(opts.port ?? 0, host, () => {
			const address = server.address()
			const port = typeof address === "object" && address !== null ? address.port : 0
			resolvePromise({
				port,
				stop: () =>
					new Promise<void>((resolveStop) => {
						server.close(() => resolveStop())
					}),
			})
		})
	})
}
