import { afterEach, describe, expect, it } from "vitest"
import { type FakeLlmServer, startFakeLlmServer } from "./server.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function postCompletions(baseUrl: string, body: Record<string, unknown>): Promise<Response> {
	return fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	})
}

async function readStreamingText(res: Response): Promise<string> {
	const text = await res.text()
	return text
}

function extractDeltaContents(sseBody: string): string[] {
	const contents: string[] = []
	for (const line of sseBody.split("\n")) {
		if (!line.startsWith("data: ")) continue
		const payload = line.slice("data: ".length).trim()
		if (payload === "[DONE]") continue
		try {
			const parsed = JSON.parse(payload) as {
				choices: Array<{ delta: { content?: string }; finish_reason?: string }>
			}
			const content = parsed.choices?.[0]?.delta?.content
			if (content !== undefined) {
				contents.push(content)
			}
		} catch {
			// ignore malformed lines
		}
	}
	return contents
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startFakeLlmServer", () => {
	const servers: FakeLlmServer[] = []

	async function start(...args: Parameters<typeof startFakeLlmServer>): Promise<FakeLlmServer> {
		const srv = await startFakeLlmServer(...args)
		servers.push(srv)
		return srv
	}

	afterEach(async () => {
		for (const srv of servers.splice(0)) {
			await srv.close().catch(() => {})
		}
	})

	it("returns a baseUrl ending in /v1", async () => {
		const srv = await start({ responses: ["hello"] })
		expect(srv.baseUrl).toMatch(/\/v1$/)
	})

	it("returns a port number that is > 0", async () => {
		const srv = await start({ responses: ["hello"] })
		expect(srv.port).toBeGreaterThan(0)
	})

	it("baseUrl includes the port", async () => {
		const srv = await start({ responses: ["hello"] })
		expect(srv.baseUrl).toContain(String(srv.port))
	})

	it("streaming request returns Content-Type text/event-stream", async () => {
		const srv = await start({ responses: ["hello"] })
		const res = await postCompletions(srv.baseUrl, { stream: true })
		expect(res.headers.get("content-type")).toMatch(/text\/event-stream/)
	})

	it("streaming request body contains the response text across delta.content chunks", async () => {
		const srv = await start({ responses: ["hello"] })
		const res = await postCompletions(srv.baseUrl, { stream: true })
		const body = await readStreamingText(res)
		const chunks = extractDeltaContents(body)
		expect(chunks.join("")).toBe("hello")
	})

	it("streaming request body ends with [DONE]", async () => {
		const srv = await start({ responses: ["hello"] })
		const res = await postCompletions(srv.baseUrl, { stream: true })
		const body = await readStreamingText(res)
		expect(body).toContain("data: [DONE]")
	})

	it("non-streaming request (stream: false) returns JSON with choices[0].message.content", async () => {
		const srv = await start({ responses: ["hello"] })
		const res = await postCompletions(srv.baseUrl, { stream: false })
		const json = (await res.json()) as {
			choices: Array<{ message: { content: string } }>
		}
		expect(json.choices[0].message.content).toBe("hello")
	})

	it("two sequential calls consume two responses in order", async () => {
		const srv = await start({ responses: ["first", "second"] })

		const res1 = await postCompletions(srv.baseUrl, { stream: false })
		const json1 = (await res1.json()) as {
			choices: Array<{ message: { content: string } }>
		}
		expect(json1.choices[0].message.content).toBe("first")

		const res2 = await postCompletions(srv.baseUrl, { stream: false })
		const json2 = (await res2.json()) as {
			choices: Array<{ message: { content: string } }>
		}
		expect(json2.choices[0].message.content).toBe("second")
	})

	it("third call after exhaustion returns HTTP 500", async () => {
		const srv = await start({ responses: ["first", "second"] })
		await postCompletions(srv.baseUrl, { stream: false })
		await postCompletions(srv.baseUrl, { stream: false })
		const res = await postCompletions(srv.baseUrl, { stream: false })
		expect(res.status).toBe(500)
	})

	it("500 error body contains 'no more scripted responses'", async () => {
		const srv = await start({ responses: [] })
		const res = await postCompletions(srv.baseUrl, { stream: false })
		const json = (await res.json()) as { error: string }
		expect(json.error).toBe("no more scripted responses")
	})

	it("close() resolves and subsequent fetch rejects or errors", async () => {
		const srv = await start({ responses: ["hello"] })
		await srv.close()
		// Remove from cleanup list since we already closed it
		const idx = servers.indexOf(srv)
		if (idx !== -1) servers.splice(idx, 1)

		await expect(postCompletions(srv.baseUrl, { stream: false })).rejects.toThrow()
	})

	it("object response with text field works the same as string response", async () => {
		const srv = await start({ responses: [{ text: "from object" }] })
		const res = await postCompletions(srv.baseUrl, { stream: false })
		const json = (await res.json()) as {
			choices: Array<{ message: { content: string } }>
		}
		expect(json.choices[0].message.content).toBe("from object")
	})

	it("default (no stream field) behaves as streaming", async () => {
		const srv = await start({ responses: ["implicit stream"] })
		const res = await postCompletions(srv.baseUrl, {})
		expect(res.headers.get("content-type")).toMatch(/text\/event-stream/)
	})
})
