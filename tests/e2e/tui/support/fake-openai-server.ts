import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http"
import type { Socket } from "node:net"
import { setTimeout as sleep } from "node:timers/promises"

export interface FakeModel {
	slug: string
	displayName: string
	provider?: string
	reasoning?: boolean
	input?: ("text" | "image")[]
	contextWindow?: number
	maxTokens?: number
}

export interface FakeToolCall {
	id?: string
	index?: number
	type?: "function"
	function: {
		name: string
		arguments: string
	}
}

export interface FakeResponseScript {
	/** Text chunks emitted as `delta.content` (the visible assistant response). */
	stream?: string[]
	/**
	 * Reasoning chunks emitted as `delta.reasoning_content` BEFORE `stream`.
	 * The upstream `openai-completions` provider maps these to `thinking_start`
	 * / `thinking_delta` / `thinking_end` events, which the UI surfaces as
	 * the cooking-animation "thinking…" suffix.
	 */
	thinking?: string[]
	/** Per-chunk delay for `stream` chunks. Defaults to `delayMs`. */
	textDelayMs?: number
	/** Per-chunk delay for `thinking` chunks. Defaults to `delayMs`. */
	thinkingDelayMs?: number
	/** Fallback delay applied to both `thinking` and `stream` chunks. */
	delayMs?: number
	toolCalls?: FakeToolCall[]
	closeSocketAfterChunks?: number
	status?: number
	body?: unknown
}

export interface RecordedRequest {
	method: string
	url: string
	headers: Record<string, string | string[] | undefined>
	body: unknown
	aborted: boolean
}

export interface FakeOpenAiServer {
	baseUrl: string
	requests: RecordedRequest[]
	stop(): Promise<void>
}

interface StartFakeOpenAiServerOptions {
	models?: FakeModel[]
	responses: FakeResponseScript[]
}

export const DEFAULT_MODEL: Required<FakeModel> = {
	slug: "basic",
	displayName: "Fake Basic",
	provider: "openai",
	reasoning: false,
	input: ["text"],
	contextWindow: 8192,
	maxTokens: 1024,
}

/** Fill every optional field of a partial model spec from DEFAULT_MODEL. */
export function withModelDefaults(model: FakeModel): Required<FakeModel> {
	return {
		slug: model.slug,
		displayName: model.displayName,
		provider: model.provider ?? DEFAULT_MODEL.provider,
		reasoning: model.reasoning ?? DEFAULT_MODEL.reasoning,
		input: model.input ?? DEFAULT_MODEL.input,
		contextWindow: model.contextWindow ?? DEFAULT_MODEL.contextWindow,
		maxTokens: model.maxTokens ?? DEFAULT_MODEL.maxTokens,
	}
}

export function resolveModels(models: FakeModel[] | undefined): Required<FakeModel>[] {
	const list = models && models.length > 0 ? models : [DEFAULT_MODEL]
	return list.map(withModelDefaults)
}

export async function startFakeOpenAiServer(options: StartFakeOpenAiServerOptions): Promise<FakeOpenAiServer> {
	const requests: RecordedRequest[] = []
	const sockets = new Set<Socket>()
	const models = resolveModels(options.models)
	const responseQueue = [...options.responses]

	const server = createServer(async (req, res) => {
		const body = await readJsonBody(req)
		const recorded: RecordedRequest = {
			method: req.method ?? "GET",
			url: req.url ?? "/",
			headers: req.headers,
			body,
			aborted: false,
		}
		req.on("aborted", () => {
			recorded.aborted = true
		})
		requests.push(recorded)

		try {
			if (req.method === "GET" && req.url?.startsWith("/v1/models/metadata")) {
				writeJson(res, 200, {
					models: models.map((model) => ({
						slug: model.slug,
						display_name: model.displayName,
						provider: model.provider,
						reasoning: model.reasoning,
						input_modalities: model.input,
						is_serverless: true,
						limits: {
							context_window: model.contextWindow,
							max_output_tokens: model.maxTokens,
						},
						status: "active",
					})),
				})
				return
			}

			if (req.method === "POST" && req.url?.startsWith("/openai/v1/chat/completions")) {
				const script = responseQueue.shift() ?? { stream: ["fake response"] }
				await writeChatCompletion(res, script, body)
				return
			}

			writeJson(res, 404, { error: `Unhandled fake OpenAI route: ${req.method} ${req.url}` })
		} catch (error) {
			if (!res.headersSent) {
				writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
			} else {
				res.destroy(error instanceof Error ? error : new Error(String(error)))
			}
		}
	})
	server.on("connection", (socket) => {
		sockets.add(socket)
		socket.on("close", () => sockets.delete(socket))
	})

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject)
			resolve()
		})
	})

	const address = server.address()
	if (!address || typeof address === "string") {
		await closeServer(server, sockets)
		throw new Error("Fake OpenAI server did not bind to a TCP port")
	}

	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		requests,
		stop: () => closeServer(server, sockets),
	}
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = []
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	}
	if (chunks.length === 0) return undefined
	const raw = Buffer.concat(chunks).toString("utf-8")
	try {
		return JSON.parse(raw)
	} catch {
		return raw
	}
}

async function writeChatCompletion(res: ServerResponse, script: FakeResponseScript, body: unknown): Promise<void> {
	if (script.status && script.status >= 400) {
		writeJson(res, script.status, script.body ?? { error: "scripted fake model error" })
		return
	}

	const request = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
	const model = typeof request.model === "string" ? request.model : DEFAULT_MODEL.slug
	if (request.stream === false) {
		writeJson(res, 200, {
			id: "chatcmpl_fake",
			object: "chat.completion",
			created: unixNow(),
			model,
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: (script.stream ?? []).join("") },
					finish_reason: "stop",
				},
			],
		})
		return
	}

	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	})

	// Emit one chunk envelope; only `choices` varies between chunks.
	const chunk = (choices: unknown[]) =>
		writeSse(res, { id: "chatcmpl_fake", object: "chat.completion.chunk", created: unixNow(), model, choices })

	let emitted = 0
	chunk([{ index: 0, delta: { role: "assistant" }, finish_reason: null }])

	for (const text of script.thinking ?? []) {
		const delay = script.thinkingDelayMs ?? script.delayMs
		if (delay) await sleep(delay)
		chunk([{ index: 0, delta: { reasoning_content: text }, finish_reason: null }])
		emitted += 1
		if (script.closeSocketAfterChunks && emitted >= script.closeSocketAfterChunks) {
			res.destroy()
			return
		}
	}

	for (const text of script.stream ?? []) {
		const delay = script.textDelayMs ?? script.delayMs
		if (delay) await sleep(delay)
		chunk([{ index: 0, delta: { content: text }, finish_reason: null }])
		emitted += 1
		if (script.closeSocketAfterChunks && emitted >= script.closeSocketAfterChunks) {
			res.destroy()
			return
		}
	}

	// Substitute dynamic ids from previous tool results into scripted tool args.
	const fermentId = extractFermentId(body)
	const agentId = extractAgentId(body)
	for (const toolCall of script.toolCalls ?? []) {
		const fn = { ...toolCall.function }
		if (fermentId) fn.arguments = fn.arguments.replaceAll("__FERMENT_ID__", fermentId)
		if (agentId) fn.arguments = fn.arguments.replaceAll("__AGENT_ID__", agentId)
		chunk([
			{
				index: 0,
				delta: {
					tool_calls: [
						{
							index: toolCall.index ?? 0,
							id: toolCall.id ?? "call_fake",
							type: toolCall.type ?? "function",
							function: fn,
						},
					],
				},
				finish_reason: null,
			},
		])
	}

	chunk([{ index: 0, delta: {}, finish_reason: script.toolCalls?.length ? "tool_calls" : "stop" }])
	res.write("data: [DONE]\n\n")
	res.end()
}

/** Pull the ferment id the host put in the scoping nudge (`ferment_id: "<uuid>"`). */
function extractFermentId(body: unknown): string | undefined {
	const match = JSON.stringify(body ?? "").match(/ferment_id[\\"\s:]+([0-9a-fA-F-]{8,})/)
	return match?.[1]
}

/** Pull the Agent id from prior Agent tool output (`Agent ID: <id>` or `agent_id`). */
function extractAgentId(body: unknown): string | undefined {
	const messages = asRecord(body).messages
	if (Array.isArray(messages)) {
		for (const message of [...messages].reverse()) {
			const fromMessage = extractAgentIdFromValue(message)
			if (fromMessage) return fromMessage
			const content = asRecord(message).content
			const fromContent = extractAgentIdFromText(readMessageContent(content))
			if (fromContent) return fromContent
		}
	}
	return extractAgentIdFromText(JSON.stringify(body ?? ""))
}

function extractAgentIdFromValue(value: unknown): string | undefined {
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = extractAgentIdFromValue(item)
			if (found) return found
		}
		return undefined
	}
	const record = asRecord(value)
	for (const key of ["agent_id", "agentId"]) {
		const found = parseAgentId(record[key])
		if (found) return found
	}
	return undefined
}

function readMessageContent(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.map((part) => {
			if (typeof part === "string") return part
			const record = asRecord(part)
			return typeof record.text === "string" ? record.text : ""
		})
		.join("\n")
}

function extractAgentIdFromText(text: string): string | undefined {
	return text.match(/Agent ID:\s*([0-9a-fA-F-]{8,})/)?.[1] ?? text.match(/agent_?id[\\"\s:]+([0-9a-fA-F-]{8,})/i)?.[1]
}

function parseAgentId(value: unknown): string | undefined {
	return typeof value === "string" && /^[0-9a-fA-F-]{8,}$/.test(value) ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function unixNow(): number {
	return Math.floor(Date.now() / 1000)
}

function writeSse(res: ServerResponse, event: unknown): void {
	res.write(`data: ${JSON.stringify(event)}\n\n`)
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" })
	res.end(JSON.stringify(body))
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
	for (const socket of sockets) socket.destroy()
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error)
			else resolve()
		})
	})
}
