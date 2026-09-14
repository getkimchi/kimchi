import { beforeEach, describe, expect, it } from "vitest"
import {
	type A2aState,
	type AgentCard,
	BURST_MAX,
	createA2aState,
	handleA2aRequest,
	MAX_INFLIGHT_TASKS,
	replyFromTask,
	startA2aServer,
} from "./a2a-server.js"

const CARD: AgentCard = {
	name: "alpha",
	description: "test session",
	url: "http://127.0.0.1:0/",
	protocolVersion: "1.0",
	version: "0.1.0",
	capabilities: { streaming: false, pushNotifications: false },
	defaultInputModes: ["text/plain"],
	defaultOutputModes: ["text/plain"],
	skills: [{ id: "coding-session", name: "Coding session", description: "test" }],
	securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
	security: [{ bearer: [] }],
}

const TOKEN = "test-token"

function makeState(deliver?: A2aState["deliver"]): A2aState {
	return createA2aState({
		card: { ...CARD, url: "http://127.0.0.1:12345/" },
		token: TOKEN,
		deliver: deliver ?? (async (text) => `reply:${text}`),
	})
}

function send(state: A2aState, text: string, fromName?: string, id = 1) {
	return handleA2aRequest(state, {
		httpMethod: "POST",
		path: "/",
		authHeader: `Bearer ${TOKEN}`,
		rawBody: JSON.stringify({
			jsonrpc: "2.0",
			id,
			method: "message/send",
			params: { message: { role: "user", parts: [{ kind: "text", text }], metadata: { fromName } } },
		}),
	})
}

async function settledTask(state: A2aState, taskId: string) {
	for (let i = 0; i < 50; i++) {
		const res = handleA2aRequest(state, {
			httpMethod: "POST",
			path: "/",
			authHeader: `Bearer ${TOKEN}`,
			rawBody: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tasks/get", params: { id: taskId } }),
		})
		const task = (res.body as { result?: { status?: { state?: string } } }).result
		if (task?.status?.state && task.status.state !== "working") return res
		await new Promise((r) => setTimeout(r, 10))
	}
	throw new Error("task never settled")
}

beforeEach(() => {})

describe("A2A request handler", () => {
	it("serves the agent card without auth", () => {
		const state = makeState()
		const res = handleA2aRequest(state, { httpMethod: "GET", path: "/.well-known/agent-card.json" })
		expect(res.status).toBe(200)
		expect((res.body as AgentCard).name).toBe("alpha")
	})

	it("returns 404 for unknown paths and non-POST methods", () => {
		const state = makeState()
		expect(handleA2aRequest(state, { httpMethod: "GET", path: "/" }).status).toBe(404)
		expect(handleA2aRequest(state, { httpMethod: "PUT", path: "/" }).status).toBe(404)
	})

	it("rejects RPC without or with wrong bearer token", () => {
		const state = makeState()
		const missing = handleA2aRequest(state, { httpMethod: "POST", path: "/", rawBody: "{}" })
		expect(missing.status).toBe(401)
		const wrong = handleA2aRequest(state, { httpMethod: "POST", path: "/", authHeader: "Bearer nope", rawBody: "{}" })
		expect(wrong.status).toBe(401)
	})

	it("reports parse and protocol errors", () => {
		const state = makeState()
		const bad = handleA2aRequest(state, {
			httpMethod: "POST",
			path: "/",
			authHeader: `Bearer ${TOKEN}`,
			rawBody: "{oops",
		})
		expect((bad.body as { error: { code: number } }).error.code).toBe(-32700)
		const notRpc = handleA2aRequest(state, {
			httpMethod: "POST",
			path: "/",
			authHeader: `Bearer ${TOKEN}`,
			rawBody: JSON.stringify({ id: 1 }),
		})
		expect((notRpc.body as { error: { code: number } }).error.code).toBe(-32600)
		const unknown = handleA2aRequest(state, {
			httpMethod: "POST",
			path: "/",
			authHeader: `Bearer ${TOKEN}`,
			rawBody: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "nope" }),
		})
		expect((unknown.body as { error: { code: number } }).error.code).toBe(-32601)
	})

	it("creates a working task, settles it with the deliver reply", async () => {
		const state = makeState()
		const res = send(state, "do a thing", "peer-b")
		const task = (res.body as { result: { id: string; status: { state: string } } }).result
		expect(task.status.state).toBe("working")

		const settled = await settledTask(state, task.id)
		const done = (
			settled.body as {
				result: { status: { state: string }; history: Array<{ role: string; parts: Array<{ text: string }> }> }
			}
		).result
		expect(done.status.state).toBe("completed")
		expect(done.history.at(-1)?.parts[0]?.text).toBe("reply:do a thing")
		expect(replyFromTask(done as never)).toBe("reply:do a thing")
	})

	it("marks tasks failed when deliver throws", async () => {
		const state = makeState(async () => {
			throw new Error("refused: not accepting")
		})
		const res = send(state, "hello", "peer-b")
		const task = (res.body as { result: { id: string } }).result
		const settled = await settledTask(state, task.id)
		const done = (settled.body as { result: { status: { state: string; message?: string } } }).result
		expect(done.status.state).toBe("failed")
		expect(done.status.message).toContain("refused")
	})

	it("refuses empty/oversized messages, self-sends, bursts, duplicates, and overflow", async () => {
		const state = makeState()
		const expectErr = (res: ReturnType<typeof handleA2aRequest>, code: number) => {
			expect((res.body as { error?: { code: number } }).error?.code).toBe(code)
		}
		expectErr(send(state, ""), -32602)

		const big = "x".repeat(200_001)
		expectErr(send(state, big), -32602)

		expectErr(send(state, "hi", CARD.name), -32602)

		// Burst: different texts to avoid dedupe; the (BURST_MAX+1)th is refused.
		// Drain microtasks between sends so the instant-reply deliveries settle
		// and release their in-flight slots (a synchronous loop would otherwise
		// trip the MAX_INFLIGHT_TASKS cap — which is itself correct behavior).
		for (let i = 0; i < BURST_MAX; i++) {
			const res = send(state, `burst-${i}`, "peer-b", 100 + i)
			expect((res.body as { result?: unknown; error?: unknown }).result).toBeDefined()
			await new Promise((r) => setTimeout(r, 0))
		}
		expectErr(send(state, "burst-over", "peer-b"), -32029)
	})

	it("dedupes identical sends within the window", () => {
		const state = makeState()
		expect((send(state, "same", "peer-b").body as { result?: unknown }).result).toBeDefined()
		expect((send(state, "same", "peer-b").body as { error?: { code: number } }).error?.code).toBe(-32029)
	})

	it("caps in-flight deliveries and frees the slot on cancel", async () => {
		let release!: (reply: string) => void
		const gate = new Promise<string>((r) => {
			release = r
		})
		const state = makeState(() => gate)
		for (let i = 0; i < MAX_INFLIGHT_TASKS; i++) {
			const res = send(state, `inflight-${i}`, "peer-b", 200 + i)
			expect((res.body as { result?: unknown }).result).toBeDefined()
		}
		expect((send(state, "overflow", "peer-b").body as { error?: { code: number } }).error?.code).toBe(-32029)

		// Cancel one, slot frees.
		const firstId = (send(state, "should-fail-burst", "peer-b").body as { error?: unknown }).error
		expect(firstId).toBeDefined()
		release("late reply")
		await new Promise((r) => setTimeout(r, 20))
		const after = send(state, "fits-now", "peer-b")
		expect((after.body as { result?: unknown }).result).toBeDefined()
	})

	it("tasks/get on unknown id returns -32001", () => {
		const state = makeState()
		const res = handleA2aRequest(state, {
			httpMethod: "POST",
			path: "/",
			authHeader: `Bearer ${TOKEN}`,
			rawBody: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "nope" } }),
		})
		expect((res.body as { error: { code: number } }).error.code).toBe(-32001)
	})
})

describe("A2A HTTP listener", () => {
	it("round-trips card + send + reply over a real socket", async () => {
		const server = await startA2aServer({ card: { ...CARD, url: "" }, token: TOKEN, deliver: async (t) => `echo:${t}` })
		try {
			const cardRes = await fetch(`http://127.0.0.1:${server.port}/.well-known/agent-card.json`)
			expect(((await cardRes.json()) as AgentCard).name).toBe("alpha")

			const sendRes = await fetch(`http://127.0.0.1:${server.port}/`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "message/send",
					params: {
						message: { role: "user", parts: [{ kind: "text", text: "ping" }], metadata: { fromName: "peer" } },
					},
				}),
			})
			const task = ((await sendRes.json()) as { result: { id: string } }).result
			expect(task.id).toMatch(/^task-/)

			// Poll to completion via the client-style loop.
			let reply: string | undefined
			for (let i = 0; i < 50 && !reply; i++) {
				await new Promise((r) => setTimeout(r, 10))
				const poll = await fetch(`http://127.0.0.1:${server.port}/`, {
					method: "POST",
					headers: { Authorization: `Bearer ${TOKEN}` },
					body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: task.id } }),
				})
				const done = (await poll.json()) as {
					result: { status: { state: string }; history?: Array<{ parts: Array<{ text: string }> }> }
				}
				if (done.result.status.state === "completed") {
					reply = done.result.history?.at(-1)?.parts[0]?.text
				}
			}
			expect(reply).toBe("echo:ping")
		} finally {
			await server.stop()
		}
	})
})
