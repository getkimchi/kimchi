/**
 * Mock HTTP server that mimics Ollama's local API for TUI E2E tests.
 *
 * Mirrors tests/e2e/tui/support/fake-openai-server.ts in lifecycle and
 * RecordedRequest shape so fixtures that orchestrate both fakes can share
 * helpers without changes. Exposes the two endpoints kimchi's startup probe
 * actually hits (src/ollama.ts:probeOllamaModels → enrichFromShow):
 *
 *   - GET  /api/tags   → model catalog with details + capabilities
 *   - POST /api/show   → per-model model_info with <family>.context_length
 *
 * Every other route returns 404 { error: "unhandled" } — including
 * /v1/chat/completions, which is intentionally NOT served here. pi-mono's
 * openai-compat surface is the consumer side of the provider; the OpenAI
 * fixture is the one that owns that path when both fixtures are active.
 */

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http"
import type { Socket } from "node:net"
import { setTimeout as sleep } from "node:timers/promises"

export interface FakeOllamaModel {
	/** Ollama model reference, e.g. "llama3:8b" — used as both /api/tags name and /api/show request name. */
	name: string
	/** Parameter size string as Ollama returns it, e.g. "8B", "30B", "1.5B", "70B", "?". Parsed by src/ollama.ts:parseParameterSize. */
	parameter_size?: string
	/** Architecture family, e.g. "llama", "qwen2", "mistral". Used as the "<arch>.context_length" key prefix in /api/show model_info. */
	family?: string
	/** Capabilities tags, e.g. ["completion"], ["completion", "vision"], ["completion", "thinking"]. Mirrors what Ollama returns from /api/tags. */
	capabilities?: string[]
	/** Context window length to surface under "<family>.context_length" in /api/show model_info. Defaults to 32768 if omitted. */
	context_length?: number
	/** Quantization level string for /api/tags details.quantization_level, e.g. "Q4_K_M". */
	quantization_level?: string
}

export interface RecordedRequest {
	method: string
	url: string
	headers: Record<string, string | string[] | undefined>
	body: unknown
	aborted: boolean
}

export interface FakeOllamaServer {
	baseUrl: string
	requests: RecordedRequest[]
	stop(): Promise<void>
}

export interface FakeOllamaChatResponse {
	/** Text chunks to stream as separate SSE `delta.content` envelopes. Defaults to ["ok"] when omitted so a misconfigured fixture still responds instead of hanging. */
	stream?: string[]
	/** Delay between SSE chunks in ms. Useful for exercising streaming UI throttling without inflating real wall-clock test time. */
	delayMs?: number
	/** HTTP status (≥400) to return instead of streaming. Mirrors fake-openai-server.ts: scripted errors skip the SSE branch entirely. */
	status?: number
	/** Response body returned alongside `status`. Sent as JSON. */
	body?: unknown
}

export interface StartFakeOllamaServerOptions {
	models: FakeOllamaModel[]
	/** FIFO queue of scripted responses for POST /v1/chat/completions. Each request shifts one entry; once the queue is empty the last consumed entry is reused so a misbehaving client can't hang the fixture by sending more requests than scripts. Defaults to [{ stream: ["ok"] }] when omitted. */
	chatResponses?: FakeOllamaChatResponse[]
}

/** Default context window used when a FakeOllamaModel omits `context_length`.
 *  Matches DEFAULT_CONTEXT_WINDOW in src/ollama.ts. */
const DEFAULT_CONTEXT_WINDOW = 32768

/** Default architecture family used when a FakeOllamaModel omits `family`.
 *  Chosen so /api/show responds with "llama.context_length" — the same key
 *  shape src/ollama.ts:extractContextWindow iterates over. */
const DEFAULT_FAMILY = "llama"

/** Default parameter_size string used when a FakeOllamaModel omits it. Ollama
 *  emits "?" for unknown sizes; parseParameterSize returns null in that case,
 *  which then falls into the "standard" tier — same behavior as a fresh
 *  Ollama install that hasn't quantized metadata yet. */
const DEFAULT_PARAMETER_SIZE = "?"

/** Default capabilities array. Matches what `ollama run <model>` produces for
 *  a plain text model (no vision, no thinking). */
const DEFAULT_CAPABILITIES: string[] = ["completion"]

export async function startFakeOllamaServer(options: StartFakeOllamaServerOptions): Promise<FakeOllamaServer> {
	const requests: RecordedRequest[] = []
	const sockets = new Set<Socket>()
	const models = resolveModels(options.models)
	// Pre-seed with the spec-mandated fallback so a caller that omits
	// chatResponses still gets a sane response. A separate default entry is
	// also held outside the queue for the post-drain "reuse last" behavior.
	const initialResponses = options.chatResponses ?? [{ stream: ["ok"] }]
	const responseQueue = [...initialResponses]
	let lastChatResponse: FakeOllamaChatResponse = { stream: ["ok"] }

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
			if (req.method === "GET" && (req.url ?? "").startsWith("/api/tags")) {
				writeJson(res, 200, buildTagsResponse(models))
				return
			}

			if (req.method === "POST" && (req.url ?? "").startsWith("/api/show")) {
				const name = extractShowRequestName(body)
				const match = models.find((model) => model.name === name)
				if (!match) {
					writeJson(res, 404, { error: "model not found" })
					return
				}
				writeJson(res, 200, buildShowResponse(match))
				return
			}

			if (req.method === "POST" && (req.url ?? "").startsWith("/v1/chat/completions")) {
				// FIFO drain with last-value reuse: tests usually script N
				// responses for N requests, but pi-mono may issue a probe
				// request after a stream error, so the queue must not hang on
				// exhaustion. The first drain updates `lastChatResponse` so
				// subsequent calls replay the most recent script verbatim.
				const next = responseQueue.shift()
				if (next) lastChatResponse = next
				await writeChatCompletion(res, lastChatResponse, body)
				return
			}

			writeJson(res, 404, { error: "unhandled" })
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
		throw new Error("Fake Ollama server did not bind to a TCP port")
	}

	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		requests,
		stop: () => closeServer(server, sockets),
	}
}

/** Apply defaults to every configured model so route handlers can rely on the
 *  canonical shape without re-checking each field. Mirrors `resolveModels` in
 *  fake-openai-server.ts. `quantization_level` is left untouched when omitted
 *  so tests that don't care about quantization get a response field absent
 *  rather than an empty-string sentinel that downstream code might confuse
 *  with "real but empty". */
function resolveModels(models: FakeOllamaModel[]): Required<FakeOllamaModel>[] {
	return models.map((model) => ({
		name: model.name,
		parameter_size: model.parameter_size ?? DEFAULT_PARAMETER_SIZE,
		family: model.family ?? DEFAULT_FAMILY,
		capabilities: model.capabilities ?? [...DEFAULT_CAPABILITIES],
		context_length: model.context_length ?? DEFAULT_CONTEXT_WINDOW,
		quantization_level: model.quantization_level ?? "",
	}))
}

/** Build the JSON body for GET /api/tags. `size: 0` and `digest: "sha256:fake"`
 *  are sentinels — src/ollama.ts doesn't read them (they're only typed, never
 *  consumed), but Ollama always emits both, and stable values make recorded
 *  requests diff-friendly in test artifacts. */
function buildTagsResponse(models: Required<FakeOllamaModel>[]): unknown {
	const now = new Date().toISOString()
	return {
		models: models.map((model) => {
			const details: Record<string, string> = {
				parameter_size: model.parameter_size,
				family: model.family,
				format: "gguf",
			}
			if (model.quantization_level) details.quantization_level = model.quantization_level
			return {
				name: model.name,
				modified_at: now,
				size: 0,
				digest: "sha256:fake",
				details,
				capabilities: model.capabilities,
			}
		}),
	}
}

/** Build the JSON body for POST /api/show. The `model_info` key shape
 *  (`<family>.context_length`) is the contract src/ollama.ts:extractContextWindow
 *  relies on — any future field additions should preserve that key so the
 *  probe's context-window enrichment keeps working. */
function buildShowResponse(model: Required<FakeOllamaModel>): unknown {
	return {
		model_info: {
			[`${model.family}.context_length`]: model.context_length,
		},
		capabilities: model.capabilities,
		modified_at: new Date().toISOString(),
	}
}

/** Pull the `name` field out of a /api/show request body. Returns undefined
 *  when the body isn't an object or `name` isn't a string — the caller treats
 *  that as "model not found" and returns 404, mirroring how Ollama rejects
 *  malformed show requests. */
function extractShowRequestName(body: unknown): string | undefined {
	if (!body || typeof body !== "object") return undefined
	const candidate = (body as { name?: unknown }).name
	return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined
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

function writeJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" })
	res.end(JSON.stringify(body))
}

/** Write an OpenAI-compatible SSE or non-streaming chat completion response to the
 *  given response object. Mirrors `writeChatCompletion` in
 *  fake-openai-server.ts so pi-mono's openai-completions consumer sees the
 *  exact envelope shape it expects.
 *
 *  Two branches:
 *    1. `script.status >= 400` → JSON error (non-streaming, short-circuit).
 *    2. `request.stream === false` → `chat.completion` JSON envelope.
 *    3. Everything else (default) → SSE `chat.completion.chunk` stream.
 *       Emits role → content chunks → stop reason → `[DONE]` terminator.
 */
async function writeChatCompletion(res: ServerResponse, script: FakeOllamaChatResponse, body: unknown): Promise<void> {
	if (script.status && script.status >= 400) {
		writeJson(res, script.status, script.body ?? { error: "scripted error" })
		return
	}

	const request = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
	const model = typeof request.model === "string" ? request.model : "ollama/unknown"

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
		"Connection": "keep-alive",
	})

	// Role envelope.
	writeSse(res, {
		id: "chatcmpl_fake",
		object: "chat.completion.chunk",
		created: unixNow(),
		model,
		choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
	})

	// Content envelopes.
	for (const text of script.stream ?? []) {
		if (script.delayMs) await sleep(script.delayMs)
		writeSse(res, {
			id: "chatcmpl_fake",
			object: "chat.completion.chunk",
			created: unixNow(),
			model,
			choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
		})
	}

	// Terminator.
	writeSse(res, {
		id: "chatcmpl_fake",
		object: "chat.completion.chunk",
		created: unixNow(),
		model,
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
	})
	res.write("data: [DONE]\n\n")
	res.end()
}

/** Emit one SSE `data:` line. Same helper as fake-openai-server.ts. */
function writeSse(res: ServerResponse, event: unknown): void {
	res.write(`data: ${JSON.stringify(event)}\n\n`)
}

/** Unix timestamp in seconds. */
function unixNow(): number {
	return Math.floor(Date.now() / 1000)
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
