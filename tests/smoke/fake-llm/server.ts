/**
 * Fake LLM SSE server for smoke tests.
 *
 * Speaks the OpenAI chat completions wire format (POST /v1/chat/completions).
 * Supports both streaming (stream: true → text/event-stream) and non-streaming
 * (stream: false → single JSON) requests.
 *
 * Each POST to /v1/chat/completions consumes the next scripted response in
 * order. Once exhausted, returns 500 {"error":"no more scripted responses"}.
 */

import * as http from "node:http"

export interface FakeLlmConfig {
	/** Port to listen on. 0 = pick a random available port. Default: 0 */
	port?: number
	responses: Array<string | { text: string; toolCalls?: Array<{ name: string; args: unknown }> }>
}

export interface FakeLlmServer {
	/** e.g. "http://127.0.0.1:54321/v1" */
	baseUrl: string
	port: number
	close(): Promise<void>
}

const CHUNK_SIZE = 8

function toText(response: FakeLlmConfig["responses"][number]): string {
	return typeof response === "string" ? response : response.text
}

function buildStreamingChunks(text: string): string {
	const parts: string[] = []

	// Split text into ~CHUNK_SIZE-char pieces for realism
	for (let i = 0; i < text.length; i += CHUNK_SIZE) {
		const piece = text.slice(i, i + CHUNK_SIZE)
		const data = JSON.stringify({
			choices: [{ delta: { content: piece }, finish_reason: null }],
		})
		parts.push(`data: ${data}\n\n`)
	}

	// Final chunk: finish_reason stop
	const stop = JSON.stringify({
		choices: [{ delta: {}, finish_reason: "stop" }],
	})
	parts.push(`data: ${stop}\n\n`)
	parts.push("data: [DONE]\n\n")

	return parts.join("")
}

function buildNonStreamingBody(text: string): string {
	return JSON.stringify({
		choices: [{ message: { role: "assistant", content: text } }],
	})
}

export function startFakeLlmServer(config: FakeLlmConfig): Promise<FakeLlmServer> {
	const port = config.port ?? 0
	const responses = [...config.responses]
	let cursor = 0

	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			// Only handle POST /v1/chat/completions
			if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
				res.writeHead(404)
				res.end("Not found")
				return
			}

			// Consume request body to parse stream flag
			const chunks: Buffer[] = []
			req.on("data", (chunk: Buffer) => chunks.push(chunk))
			req.on("end", () => {
				let body: { stream?: boolean } = {}
				try {
					body = JSON.parse(Buffer.concat(chunks).toString("utf-8"))
				} catch {
					// ignore parse errors; default to streaming
				}

				// Check if we still have responses
				if (cursor >= responses.length) {
					res.writeHead(500, { "Content-Type": "application/json" })
					res.end(JSON.stringify({ error: "no more scripted responses" }))
					return
				}

				const response = responses[cursor++]
				const text = toText(response)
				const wantsStream = body.stream !== false // default to streaming

				if (wantsStream) {
					res.writeHead(200, {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
						Connection: "keep-alive",
					})
					res.end(buildStreamingChunks(text))
				} else {
					res.writeHead(200, { "Content-Type": "application/json" })
					res.end(buildNonStreamingBody(text))
				}
			})
		})

		server.on("error", reject)

		server.listen(port, "127.0.0.1", () => {
			const addr = server.address() as { port: number }
			const listenPort = addr.port

			const fakeLlmServer: FakeLlmServer = {
				baseUrl: `http://127.0.0.1:${listenPort}/v1`,
				port: listenPort,
				close(): Promise<void> {
					return new Promise((res, rej) => {
						server.close((err) => (err ? rej(err) : res()))
					})
				},
			}

			resolve(fakeLlmServer)
		})
	})
}
