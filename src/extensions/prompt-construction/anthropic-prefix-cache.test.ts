/**
 * Anthropic prefix-cache reproduction.
 *
 * Anthropic prompt caching works like this: pi-ai places `cache_control`
 * breakpoints on the system prompt, the last tool, and the LAST user-role
 * block of the converted message stream (see anthropic-messages.js). A later
 * request hits the cache only at a previously stored marker prefix that is a
 * byte-identical *prefix* of the new request body.
 *
 * The bug this test reproduces (frozen cache_read, ~full-context cache_write
 * every round): todo/ferment state was injected as a transient message at the
 * tail of the message array on every context event, with content that moved
 * position every round — every stored tail breakpoint ended at a poisoned
 * block, so no later request could ever reuse it.
 *
 * After the fix (persist-on-change + strip-only context view), consecutive
 * request bodies are strict prefix-extensions of each other except at a real
 * todo write, which causes exactly one bounded invalidation at the position
 * of the superseded state block.
 *
 * The serializer under test is the REAL anthropic-messages conversion from
 * pi-ai, captured through a stub fetch — the same technique as
 * /tmp/replay-diff.mjs, which was used to diagnose the original freeze.
 */
import type { Message, Model } from "@earendil-works/pi-ai"
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages"
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript"
import type { BeforeAgentStartEvent, ContextEvent, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent"
import { convertToLlm } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { MEMORY_PRE_REQUEST_TIMEOUT_MS } from "../memory/config.js"
import { createMemoryExtension } from "../memory/index.js"
import todosExtension from "../todos/index.js"
import { __resetTodoStore, applyWriteTodos } from "../todos/store.js"

const SESSION_ID = "cache-replay-session"

/** Session-pipeline message shape — the same element type the `context`
 *  event carries (pi-coding-agent does not re-export `AgentMessage` from
 *  its package root). */
type AgentMessage = ContextEvent["messages"][number]

// ─── Session fixture ─────────────────────────────────────────────────────────

function userMessage(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp } as unknown as AgentMessage
}

function assistantToolCall(callId: string, command: string, timestamp: number): AgentMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-5",
		content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command } }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp,
	} as unknown as AgentMessage
}

function toolResult(callId: string, text: string, timestamp: number): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName: "bash",
		content: [{ type: "text", text }],
		timestamp,
	} as unknown as AgentMessage
}

// ─── Harness: real extension over a simulated growing session ────────────────

function createHarness(registerExtension?: (pi: ExtensionAPI) => void) {
	const mock = createExtensionApi()
	const history: AgentMessage[] = []
	let timestamp = 0
	mock.sendMessage.mockImplementation((message) => {
		history.push({
			role: "custom",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			timestamp: timestamp++,
		} as unknown as AgentMessage)
	})

	const ctx = createContext({
		hasUI: false,
		hasPendingMessages: () => false,
		sessionManager: {
			getSessionId: () => SESSION_ID,
			getBranch: () => history as unknown as SessionEntry[],
		},
	})

	todosExtension(mock.api)
	registerExtension?.(mock.api)

	async function fire(event: string, payload: unknown): Promise<unknown> {
		let result: unknown
		let currentPayload = payload
		for (const handler of mock.getHandlers(event)) {
			result = await handler(currentPayload, ctx)
			if (
				event === "context" &&
				result &&
				typeof result === "object" &&
				"messages" in result &&
				Array.isArray(result.messages)
			) {
				currentPayload = { ...(currentPayload as Record<string, unknown>), messages: result.messages }
			}
		}
		return result
	}

	/** The model-visible view for the next LLM call: persistent history run
	 *  through every registered context handler (the strip-only pass). */
	async function requestView(): Promise<AgentMessage[]> {
		const result = (await fire("context", { type: "context", messages: [...history] })) as
			| { messages?: AgentMessage[] }
			| undefined
		return result?.messages ?? history
	}

	return { history, pi: mock.api, fire, requestView }
}

// ─── Real anthropic-messages wire capture ─────────────────────────────────────

const model = {
	id: "claude-sonnet-5",
	name: "claude-sonnet-5",
	api: "anthropic-messages",
	provider: "kimchi-dev/anthropic",
	baseUrl: "http://localhost:9", // intercepted by the capture fetch below
	maxTokens: 128000,
	input: ["text"],
	output: ["text"],
	reasoning: false,
} as unknown as Model<"anthropic-messages">

const TEST_TOOLS = [
	{
		name: "bash",
		description: "run bash",
		parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
	},
	{
		name: "read",
		description: "read file",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
]

interface CapturedBody {
	system: unknown
	tools: unknown
	messages: Array<Record<string, unknown>>
}

async function captureRequestBody(
	messages: AgentMessage[],
	systemPrompt = "You are a cache replay test.",
): Promise<CapturedBody> {
	let capturedBody: string | undefined
	const captureFetch = async (_url: unknown, init: unknown) => {
		capturedBody = String((init as { body?: unknown })?.body ?? "")
		return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "captured" } }), {
			status: 500,
			headers: { "content-type": "application/json" },
		})
	}
	try {
		const s = stream(
			model,
			// upstream pi: stream() takes a TranscriptContext; normalizeContext folds the
			// raw context (systemPrompt/tools here) into the transcript.
			normalizeContext({
				systemPrompt,
				tools: TEST_TOOLS,
				messages: convertToLlm(messages) as Message[],
			}),
			{ apiKey: "replay-key", fetch: captureFetch as unknown as typeof fetch },
		)
		for await (const ev of s) {
			if (ev?.type === "error") break
		}
	} catch {
		// The stub fetch always fails after the body was captured — expected.
	}
	expect(capturedBody, "request body was captured").toBeTruthy()
	return JSON.parse(capturedBody as string) as CapturedBody
}

// ─── Cache simulation ─────────────────────────────────────────────────────────

/** Anthropic stores a cache entry at every cache_control marker prefix; a
 *  later request reads only stored entries that are byte-identical prefixes.
 *  The only moving marker in these bodies is the tail marker on the last
 *  user-role block, so the stored set is exactly the set of prior
 *  serialized message arrays. */
function simulateCache(bodies: CapturedBody[]): { cacheRead: number[]; cacheWrite: number[] } {
	const stored: string[] = []
	const cacheRead: number[] = []
	const cacheWrite: number[] = []
	for (const body of bodies) {
		// Content-only comparison: cache_control markers steer writes; reads
		// match on content bytes at previously stored breakpoint prefixes.
		const key = JSON.stringify(body.messages.map(stripCacheControl))
		let read = 0
		for (const prior of stored) {
			// Array-prefix containment in JSON space: prior is a byte-prefix of
			// current iff current starts with prior minus the closing bracket.
			if (key.startsWith(prior.slice(0, -1))) {
				read = Math.max(read, prior.length)
			}
		}
		cacheRead.push(read)
		cacheWrite.push(key.length - read)
		stored.push(key)
	}
	return { cacheRead, cacheWrite }
}

function stripCacheControl(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripCacheControl)
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(value)) {
			if (k === "cache_control") continue
			out[k] = stripCacheControl(v)
		}
		return out
	}
	return value
}

function serializedMessages(body: CapturedBody): string[] {
	return body.messages.map((m) => JSON.stringify(stripCacheControl(m)))
}

/** Returns the index of the first divergent message between two serialized
 *  request bodies (messages arrays fully prefix-match up to that index). */
function firstDivergence(prev: CapturedBody, next: CapturedBody): number {
	const a = serializedMessages(prev)
	const b = serializedMessages(next)
	const n = Math.min(a.length, b.length)
	for (let i = 0; i < n; i++) {
		if (a[i] !== b[i]) return i
	}
	return n
}

function indexOfTodoStateBlock(body: CapturedBody): number {
	return body.messages.findIndex((m) => JSON.stringify(m).includes("## Current Todos"))
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("anthropic prefix-cache reproduction (persist-on-change)", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("consecutive request bodies strictly prefix-extend each other between todo writes", async () => {
		const harness = createHarness()
		let ts = 1000
		harness.history.push(userMessage("add a feature with several steps", ts++))
		await harness.fire("session_start", { reason: "new" })

		// Todo write #1: one persisted state block joins history.
		applyWriteTodos({ todos: [{ content: "explore", status: "in_progress" }] }, SESSION_ID)

		const bodies: CapturedBody[] = []
		bodies.push(await captureRequestBody(await harness.requestView()))
		expect(indexOfTodoStateBlock(bodies[0])).toBeGreaterThan(0)

		// Five working rounds with no further todo writes.
		for (let i = 1; i <= 5; i++) {
			harness.history.push(assistantToolCall(`call-${i}`, `echo ${i}`, ts++))
			harness.history.push(toolResult(`call-${i}`, `${i}`, ts++))
			bodies.push(await captureRequestBody(await harness.requestView()))
		}

		// THE reproduction property: every no-write round's body contains the
		// previous body as a strict byte-prefix. On the old tail-push design
		// the state block sat at a different position every round (and carried
		// a moving staleness counter), so this failed on every single pair —
		// that is the frozen cache_read / ~135k cache_write-per-round freeze.
		for (let i = 1; i < bodies.length; i++) {
			expect(firstDivergence(bodies[i - 1] ?? [], bodies[i] ?? [])).toBe(
				(bodies[i - 1] as CapturedBody).messages.length,
			)

			// And the tail breakpoint candidate (last message) is a real
			// persistent history message, never a transient injection.
			const last = (bodies[i] as CapturedBody).messages.at(-1)
			expect(JSON.stringify(last)).not.toContain("## Current Todos")
		}

		const { cacheRead, cacheWrite } = simulateCache(bodies)
		// cache_read grows with the conversation (victim metric: frozen ~16.8k).
		expect(cacheRead[0]).toBe(0)
		for (let i = 1; i < cacheRead.length; i++) {
			expect(cacheRead[i]).toBeGreaterThan(cacheRead[i - 1] ?? 0)
		}
		// cache_write per no-write round is bounded to the new tail chunk
		// (victim metric: ~full-context rewrite every round).
		const bodyLen = JSON.stringify(bodies.at(-1)?.messages).length
		for (let i = 1; i < cacheWrite.length; i++) {
			expect((cacheWrite[i] ?? 0) / bodyLen).toBeLessThan(0.2)
		}
	})

	it("a todo write causes exactly one bounded invalidation, then prefix growth resumes", async () => {
		const harness = createHarness()
		let ts = 1000
		harness.history.push(userMessage("multi-step task", ts++))
		await harness.fire("session_start", { reason: "new" })

		applyWriteTodos(
			{
				todos: [
					{ content: "first", status: "completed" },
					{ content: "second", status: "in_progress" },
				],
			},
			SESSION_ID,
		)

		const bodies: CapturedBody[] = []
		bodies.push(await captureRequestBody(await harness.requestView()))
		for (let i = 1; i <= 2; i++) {
			harness.history.push(assistantToolCall(`a-${i}`, `true ${i}`, ts++))
			harness.history.push(toolResult(`a-${i}`, "", ts++))
			bodies.push(await captureRequestBody(await harness.requestView()))
		}

		// Todo write #2 (mid-sequence): a new state block is appended and the
		// superseded one is stripped from the next view.
		applyWriteTodos(
			{
				todos: [
					{ content: "first", status: "completed" },
					{ content: "second", status: "completed" },
				],
			},
			SESSION_ID,
		)
		bodies.push(await captureRequestBody(await harness.requestView()))

		// The write round is the one bounded invalidation: the divergence is
		// exactly at the superseded block's position, not beyond.
		const writeRound = bodies.length - 1
		const divergence = firstDivergence(bodies[writeRound - 1] ?? [], bodies[writeRound] ?? [])
		expect(divergence).toBe(indexOfTodoStateBlock(bodies[writeRound - 1] ?? []))

		// Prefix growth resumes immediately after.
		for (let i = 0; i < 3; i++) {
			harness.history.push(assistantToolCall(`b-${i}`, `true b${i}`, ts++))
			harness.history.push(toolResult(`b-${i}`, "", ts++))
			bodies.push(await captureRequestBody(await harness.requestView()))
			const prev = bodies[bodies.length - 2] as CapturedBody
			const curr = bodies[bodies.length - 1] as CapturedBody
			expect(firstDivergence(prev, curr)).toBe(prev.messages.length)
		}

		// Cache accounting across the whole sequence: reads stay monotonic
		// aside from the single write-round reset, and no round rewrites more
		// than the tail it actually changed.
		const { cacheRead } = simulateCache(bodies)
		expect(cacheRead[0]).toBe(0)
		for (let i = writeRound + 1; i < cacheRead.length; i++) {
			expect(cacheRead[i]).toBeGreaterThan(cacheRead[i - 1] ?? 0)
		}
	})

	it("the tail cache breakpoint always lands on persistent history, including rounds after writes", async () => {
		const harness = createHarness()
		let ts = 1000
		harness.history.push(userMessage("work with todos", ts++))
		await harness.fire("session_start", { reason: "new" })

		applyWriteTodos({ todos: [{ content: "step one", status: "pending" }] }, SESSION_ID)

		for (let i = 0; i < 4; i++) {
			harness.history.push(assistantToolCall(`m-${i}`, `true ${i}`, ts++))
			harness.history.push(toolResult(`m-${i}`, "", ts++))
			if (i === 1) {
				applyWriteTodos({ todos: [{ id: 1, content: "step one", status: "in_progress" }] }, SESSION_ID)
			}
			const view = await harness.requestView()
			// The strip-only view contains no message that isn't in history:
			// whatever pi-ai marks at the tail is a persisted session message.
			for (const message of view) {
				expect(harness.history).toContain(message)
			}
		}
	})
})

describe("memory prefix stability", () => {
	const systemPrompt = "You are a cache replay test."

	function memoryStartEvent(prompt: string): BeforeAgentStartEvent {
		return {
			type: "before_agent_start",
			messageType: "user",
			systemPrompt,
			systemPromptOptions: undefined,
			prompt,
			images: [],
		} as unknown as BeforeAgentStartEvent
	}

	function resultSystemPrompt(result: unknown): string {
		return (result as { systemPrompt?: string } | undefined)?.systemPrompt ?? systemPrompt
	}

	async function startMemoryTurn(harness: ReturnType<typeof createHarness>, prompt: string): Promise<string> {
		return resultSystemPrompt(await harness.fire("before_agent_start", memoryStartEvent(prompt)))
	}

	beforeEach(() => {
		__resetTodoStore()
		vi.stubEnv("KIMCHI_MEMORY_DECISION_GATE", "off")
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllEnvs()
	})

	it("keeps the system body stable and appends delayed memory to history", async () => {
		vi.useFakeTimers()
		const search = vi.fn(() => {
			if (search.mock.calls.length === 1) return new Promise<Array<{ memory?: string }>>(() => {})
			return Promise.resolve([{ memory: "late fact", score: 0.7 }])
		})
		const harness = createHarness((pi) =>
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) })(pi),
		)
		harness.history.push(userMessage("turn 1", 1_000))
		const pending = harness.fire("before_agent_start", memoryStartEvent("turn 1"))
		await vi.advanceTimersByTimeAsync(MEMORY_PRE_REQUEST_TIMEOUT_MS + 10)
		const firstPrompt = resultSystemPrompt(await pending)
		const first = await captureRequestBody(await harness.requestView(), firstPrompt)

		harness.history.push(userMessage("turn 2", 1_001))
		const secondPrompt = await startMemoryTurn(harness, "turn 2")
		expect(secondPrompt).toBe(firstPrompt)
		await vi.waitFor(() =>
			expect(harness.history.some((message) => JSON.stringify(message).includes("late fact"))).toBe(true),
		)
		const second = await captureRequestBody(await harness.requestView(), secondPrompt)

		expect(second.system).toEqual(first.system)
		expect(second.tools).toEqual(first.tools)
		expect(firstDivergence(first, second)).toBe(first.messages.length)
		const { cacheRead } = simulateCache([first, second])
		expect(cacheRead[1]).toBeGreaterThan(cacheRead[0])
	})

	it("feeds context handlers their predecessors' messages", async () => {
		const seen: string[] = []
		const harness = createHarness((pi) => {
			pi.on("context", (event: ContextEvent) => {
				seen.push("first")
				return { messages: [...event.messages, userMessage("first-injected", 1_000)] }
			})
			pi.on("context", (event: ContextEvent) => {
				seen.push("second")
				return { messages: [...event.messages, userMessage("second-injected", 1_001)] }
			})
		})
		const view = await harness.requestView()
		expect(seen).toEqual(["first", "second"])
		expect(JSON.stringify(view)).toContain("first-injected")
		expect(JSON.stringify(view)).toContain("second-injected")
	})

	it("reuses an immediate digest without later system changes", async () => {
		const search = vi.fn(async () => [{ memory: "immediate fact", score: 0.7 }])
		const harness = createHarness((pi) =>
			createMemoryExtension({ isEnabled: () => true, createSearcher: async () => ({ search }) })(pi),
		)
		harness.history.push(userMessage("turn 1", 1_000))
		const firstPrompt = await startMemoryTurn(harness, "turn 1")
		expect(firstPrompt).toContain("immediate fact")
		const first = await captureRequestBody(await harness.requestView(), firstPrompt)

		harness.history.push(userMessage("turn 2", 1_001))
		const secondPrompt = await startMemoryTurn(harness, "turn 2")
		expect(secondPrompt).toBe(firstPrompt)
		const second = await captureRequestBody(await harness.requestView(), secondPrompt)
		expect(second.system).toEqual(first.system)
		expect(firstDivergence(first, second)).toBe(first.messages.length)
	})

	it("keeps identical base prompts with memory disabled", async () => {
		const search = vi.fn(async () => [{ memory: "unused fact", score: 0.7 }])
		const harness = createHarness((pi) =>
			createMemoryExtension({ isEnabled: () => false, createSearcher: async () => ({ search }) })(pi),
		)
		harness.history.push(userMessage("turn 1", 1_000))
		const firstPrompt = await startMemoryTurn(harness, "turn 1")
		const first = await captureRequestBody(await harness.requestView(), firstPrompt)

		harness.history.push(userMessage("turn 2", 1_001))
		const secondPrompt = await startMemoryTurn(harness, "turn 2")
		expect(secondPrompt).toBe(firstPrompt)
		const second = await captureRequestBody(await harness.requestView(), secondPrompt)
		expect(second.system).toEqual(first.system)
		expect(firstDivergence(first, second)).toBe(first.messages.length)
		expect(search).not.toHaveBeenCalled()
	})
})
