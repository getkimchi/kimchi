import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
	ThinkingContent,
} from "@earendil-works/pi-ai"
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai"
import { afterEach, describe, expect, it } from "vitest"
import { DEFAULT_MAX_THINKING_TOKENS, MAX_THINKING_TOKENS_ENV, resolveMaxThinkingTokens } from "./models.js"
import {
	__resetSuppression,
	CHARS_PER_TOKEN,
	createThinkingBudgetStreamFn,
	installThinkingBudgetPatch,
	suppressThinkingBudgetForNextTurn,
	THINKING_BUDGET_DIAGNOSTIC_TYPE,
	wrapAgentStreamFn,
} from "./upstream-thinking-budget-patch.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MODEL = {
	id: "test-model",
	api: "openai-completions",
	provider: "test",
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
} as unknown as Model<Api>

const CONTEXT = {
	systemPrompt: "sys",
	messages: [{ role: "user" as const, content: "hello", timestamp: 0 }],
}

function emptyUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	}
}

/**
 * Builds a stream script around one mutable partial message, the way real
 * providers do — every event carries the same `partial` by reference.
 */
function script() {
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 0,
	}
	const events: AssistantMessageEvent[] = []

	const api = {
		partial,
		events,
		thinking(text: string, chunk = 32) {
			const contentIndex = partial.content.length
			partial.content.push({ type: "thinking", thinking: "" })
			events.push({ type: "thinking_start", contentIndex, partial })
			for (let i = 0; i < text.length; i += chunk) {
				const delta = text.slice(i, i + chunk)
				;(partial.content[contentIndex] as ThinkingContent).thinking += delta
				events.push({ type: "thinking_delta", contentIndex, delta, partial })
			}
			return api
		},
		text(body: string, chunk = 32) {
			const contentIndex = partial.content.length
			partial.content.push({ type: "text", text: "" })
			events.push({ type: "text_start", contentIndex, partial })
			for (let i = 0; i < body.length; i += chunk) {
				const delta = body.slice(i, i + chunk)
				const block = partial.content[contentIndex]
				if (block.type === "text") block.text += delta
				events.push({ type: "text_delta", contentIndex, delta, partial })
			}
			return api
		},
		/** A tool call that finishes streaming (emits toolcall_end). */
		toolCall(name: string, args: Record<string, unknown>) {
			const contentIndex = partial.content.length
			const toolCall = { type: "toolCall" as const, id: `call_${contentIndex}`, name, arguments: args }
			partial.content.push(toolCall)
			events.push({ type: "toolcall_start", contentIndex, partial })
			events.push({ type: "toolcall_end", contentIndex, toolCall, partial })
			return api
		},
		/** A tool call whose end event never arrives — the shape an abort leaves behind. */
		danglingToolCall(name: string) {
			const contentIndex = partial.content.length
			partial.content.push({ type: "toolCall", id: `call_${contentIndex}`, name, arguments: {} })
			events.push({ type: "toolcall_start", contentIndex, partial })
			return api
		},
	}
	return api
}

interface ProviderSpy {
	abortCount: number
	sawSignal?: AbortSignal
	stream?: AssistantMessageEventStream
}

/**
 * Fake provider mimicking the openai-completions abort path: the SSE iterator
 * swallows the abort, blocks are finalized, and a terminal `error`/"aborted"
 * event is pushed carrying the accumulated message.
 */
function fakeProvider(
	built: ReturnType<typeof script>,
	options: { ignoreAbort?: boolean; doneReason?: "stop" | "toolUse" | "length"; finalUsage?: number } = {},
) {
	const spy: ProviderSpy = { abortCount: 0 }
	const fn = async (
		_model: Model<Api>,
		_context: unknown,
		streamOptions?: { signal?: AbortSignal },
	): Promise<AssistantMessageEventStream> => {
		const stream = createAssistantMessageEventStream()
		spy.stream = stream
		spy.sawSignal = streamOptions?.signal
		streamOptions?.signal?.addEventListener("abort", () => {
			spy.abortCount += 1
		})

		void (async () => {
			for (const event of built.events) {
				if (streamOptions?.signal?.aborted && !options.ignoreAbort) break
				stream.push(event)
				// Yield to the macrotask queue so the consumer processes this event
				// (and can abort) before the next one is pushed.
				await new Promise((resolve) => setTimeout(resolve, 0))
			}
			if (options.ignoreAbort) return

			if (streamOptions?.signal?.aborted) {
				const error: AssistantMessage = {
					...built.partial,
					stopReason: "aborted",
					errorMessage: "Request was aborted",
				}
				stream.push({ type: "error", reason: "aborted", error })
				stream.end(error)
				return
			}
			if (options.finalUsage) {
				built.partial.usage = { ...emptyUsage(), output: options.finalUsage, totalTokens: options.finalUsage }
			}
			const message: AssistantMessage = { ...built.partial, stopReason: options.doneReason ?? "stop" }
			stream.push({ type: "done", reason: options.doneReason ?? "stop", message })
			stream.end(message)
		})()

		return stream
	}
	return { fn, spy }
}

async function collect(stream: AssistantMessageEventStream) {
	const events: AssistantMessageEvent[] = []
	for await (const event of stream) events.push(event)
	return { events, result: await stream.result() }
}

const agentTurn = () => true

afterEach(() => {
	__resetSuppression()
	delete process.env[MAX_THINKING_TOKENS_ENV]
})

// ---------------------------------------------------------------------------

describe("resolveMaxThinkingTokens", () => {
	it("defaults when unset or blank", () => {
		expect(resolveMaxThinkingTokens({})).toBe(DEFAULT_MAX_THINKING_TOKENS)
		expect(resolveMaxThinkingTokens({ [MAX_THINKING_TOKENS_ENV]: "  " })).toBe(DEFAULT_MAX_THINKING_TOKENS)
	})

	it("reads an integer override and accepts 0 as disabled", () => {
		expect(resolveMaxThinkingTokens({ [MAX_THINKING_TOKENS_ENV]: "8000" })).toBe(8000)
		expect(resolveMaxThinkingTokens({ [MAX_THINKING_TOKENS_ENV]: "0" })).toBe(0)
	})

	it("falls back rather than truncating at the first non-digit", () => {
		// parseInt would read "8k" as 8 and cut every turn after two words.
		expect(resolveMaxThinkingTokens({ [MAX_THINKING_TOKENS_ENV]: "8k" })).toBe(DEFAULT_MAX_THINKING_TOKENS)
		expect(resolveMaxThinkingTokens({ [MAX_THINKING_TOKENS_ENV]: "-1" })).toBe(DEFAULT_MAX_THINKING_TOKENS)
		expect(resolveMaxThinkingTokens({ [MAX_THINKING_TOKENS_ENV]: "1.5" })).toBe(DEFAULT_MAX_THINKING_TOKENS)
	})
})

describe("createThinkingBudgetStreamFn — pass-through", () => {
	it("forwards every event and the terminal reason when under budget", async () => {
		const built = script().thinking("short reasoning").text("the answer")
		const provider = fakeProvider(built, { doneReason: "stop" })
		const wrapped = createThinkingBudgetStreamFn(provider.fn, {
			isAgentTurn: agentTurn,
			resolveBudget: () => 1000,
		})

		const { events, result } = await collect(await wrapped(MODEL, CONTEXT, {}))

		expect(events.map((e) => e.type)).toEqual(["thinking_start", "thinking_delta", "text_start", "text_delta", "done"])
		expect(result.stopReason).toBe("stop")
		expect(provider.spy.abortCount).toBe(0)
	})

	it("returns the provider's own stream untouched when the budget is 0", async () => {
		const built = script().thinking("x".repeat(10_000), 1_000)
		const provider = fakeProvider(built)
		const wrapped = createThinkingBudgetStreamFn(provider.fn, {
			isAgentTurn: agentTurn,
			resolveBudget: () => 0,
		})

		const stream = await wrapped(MODEL, CONTEXT, {})
		expect(stream).toBe(provider.spy.stream)
		expect((await collect(stream)).result.stopReason).toBe("stop")
		expect(provider.spy.abortCount).toBe(0)
	})

	it("never counts text deltas, however large", async () => {
		const built = script().text("x".repeat(200_000), 20_000)
		const provider = fakeProvider(built)
		const wrapped = createThinkingBudgetStreamFn(provider.fn, {
			isAgentTurn: agentTurn,
			resolveBudget: () => 10,
		})

		const { result } = await collect(await wrapped(MODEL, CONTEXT, {}))
		expect(result.stopReason).toBe("stop")
		expect(provider.spy.abortCount).toBe(0)
	})

	// The regression test for the sharpest edge in this patch: agent.streamFn also
	// drives compaction and branch summarization, and capping thinking there would
	// truncate the summary and silently destroy context.
	it("exempts non-agent turns (compaction) no matter how much they think", async () => {
		const built = script().thinking("x".repeat(100_000), 10_000)
		const provider = fakeProvider(built)
		const wrapped = createThinkingBudgetStreamFn(provider.fn, {
			isAgentTurn: () => false,
			resolveBudget: () => 10,
		})

		const stream = await wrapped(MODEL, CONTEXT, { signal: new AbortController().signal })
		expect(stream).toBe(provider.spy.stream)
		expect((await collect(stream)).result.stopReason).toBe("stop")
		expect(provider.spy.abortCount).toBe(0)
	})

	// The production predicate, not an injected one: compaction is separated from
	// an agent turn purely by whether the call carries the run's own signal.
	describe("the wired isAgentTurn predicate", () => {
		const overBudget = "t".repeat(4_000)

		function wrappedAgent(runSignal: AbortSignal | undefined) {
			const provider = fakeProvider(script().thinking(overBudget, 200))
			const agent = { streamFn: provider.fn, signal: runSignal }
			wrapAgentStreamFn(agent, { resolveBudget: () => 10 })
			return { agent, provider }
		}

		it("caps a call carrying the run's own signal", async () => {
			const run = new AbortController()
			const { agent } = wrappedAgent(run.signal)

			const stream = await agent.streamFn(MODEL, CONTEXT, { signal: run.signal })
			expect((await collect(stream)).result.stopReason).toBe("length")
		})

		it("exempts a call carrying a different signal (compaction)", async () => {
			const run = new AbortController()
			const compaction = new AbortController()
			const { agent, provider } = wrappedAgent(run.signal)

			const stream = await agent.streamFn(MODEL, CONTEXT, { signal: compaction.signal })
			expect((await collect(stream)).result.stopReason).toBe("stop")
			expect(provider.spy.abortCount).toBe(0)
		})

		it("exempts a call with no signal even when the agent is idle", async () => {
			// Both sides undefined must not compare equal into "this is a turn".
			const { agent, provider } = wrappedAgent(undefined)

			const stream = await agent.streamFn(MODEL, CONTEXT, {})
			expect((await collect(stream)).result.stopReason).toBe("stop")
			expect(provider.spy.abortCount).toBe(0)
		})
	})
})

describe("createThinkingBudgetStreamFn — truncation", () => {
	const budget = 10
	const overBudgetText = "t".repeat(budget * CHARS_PER_TOKEN + 200)

	it("aborts once and reports the turn as a length truncation", async () => {
		const built = script().thinking(overBudgetText, 20)
		const provider = fakeProvider(built)
		const wrapped = createThinkingBudgetStreamFn(provider.fn, {
			isAgentTurn: agentTurn,
			resolveBudget: () => budget,
		})

		const { events, result } = await collect(await wrapped(MODEL, CONTEXT, {}))

		expect(provider.spy.abortCount).toBe(1)
		const terminal = events[events.length - 1]
		expect(terminal.type).toBe("done")
		expect(terminal.type === "done" && terminal.reason).toBe("length")
		expect(result.stopReason).toBe("length")
		expect(result.errorMessage).toBeUndefined()
		// The provider's own terminal event must not leak through.
		expect(events.filter((e) => e.type === "error")).toHaveLength(0)
	})

	it("keeps the partial thinking and records a diagnostic", async () => {
		const built = script().thinking(overBudgetText, 20)
		const wrapped = createThinkingBudgetStreamFn(fakeProvider(built).fn, {
			isAgentTurn: agentTurn,
			resolveBudget: () => budget,
		})

		const { result } = await collect(await wrapped(MODEL, CONTEXT, {}))

		const thinking = result.content.find((block) => block.type === "thinking")
		expect(thinking && thinking.type === "thinking" && thinking.thinking.length).toBeGreaterThan(0)
		const diagnostic = result.diagnostics?.find((d) => d.type === THINKING_BUDGET_DIAGNOSTIC_TYPE)
		expect(diagnostic).toBeDefined()
		expect(diagnostic?.details?.budget).toBe(budget)
		expect(diagnostic?.details?.usageEstimated).toBe(true)
	})

	// A zeroed usage would become the session's authoritative "last usage",
	// collapsing context accounting and disabling auto-compaction.
	it("synthesizes non-zero usage when the provider never sent a usage chunk", async () => {
		const built = script().thinking(overBudgetText, 20)
		const wrapped = createThinkingBudgetStreamFn(fakeProvider(built).fn, {
			isAgentTurn: agentTurn,
			resolveBudget: () => budget,
		})

		const { result } = await collect(await wrapped(MODEL, CONTEXT, {}))

		expect(result.usage.totalTokens).toBeGreaterThan(0)
		expect(result.usage.input).toBeGreaterThan(0)
		expect(result.usage.output).toBeGreaterThan(0)
		expect(result.usage.totalTokens).toBe(result.usage.input + result.usage.output)
		expect(result.usage.cost.total).toBeGreaterThan(0)
	})

	// Tool definitions are part of the prompt but not of `messages`; leaving them
	// out measured ~40% low against the provider's own figure for the same request.
	it("counts tool definitions towards the input estimate", async () => {
		const wrapped = createThinkingBudgetStreamFn(
			async (...args) => fakeProvider(script().thinking(overBudgetText, 20)).fn(...args),
			{ isAgentTurn: agentTurn, resolveBudget: () => budget },
		)

		const withoutTools = (await collect(await wrapped(MODEL, CONTEXT, {}))).result
		const withTools = (
			await collect(
				await wrapped(
					MODEL,
					{ ...CONTEXT, tools: [{ name: "bash", description: "x".repeat(4_000), parameters: {} }] } as never,
					{},
				),
			)
		).result

		expect(withTools.usage.input).toBeGreaterThan(withoutTools.usage.input + 900)
	})

	it("preserves provider usage when a usage chunk did arrive", async () => {
		const built = script().thinking(overBudgetText, 20)
		// The provider settles with real usage before we finish reading.
		built.partial.usage = { ...emptyUsage(), input: 111, output: 222, totalTokens: 333 }
		const wrapped = createThinkingBudgetStreamFn(fakeProvider(built).fn, {
			isAgentTurn: agentTurn,
			resolveBudget: () => budget,
		})

		const { result } = await collect(await wrapped(MODEL, CONTEXT, {}))
		expect(result.usage.totalTokens).toBe(333)
		const diagnostic = result.diagnostics?.find((d) => d.type === THINKING_BUDGET_DIAGNOSTIC_TYPE)
		expect(diagnostic?.details?.usageEstimated).toBe(false)
	})

	it("keeps tool calls that finished before the trip and drops the rest", async () => {
		const built = script()
			.toolCall("read_file", { path: "a.ts" })
			.thinking(overBudgetText, 20)
			.danglingToolCall("write_file")
		const wrapped = createThinkingBudgetStreamFn(fakeProvider(built).fn, {
			isAgentTurn: agentTurn,
			resolveBudget: () => budget,
		})

		const { result } = await collect(await wrapped(MODEL, CONTEXT, {}))

		const toolCalls = result.content.filter((block) => block.type === "toolCall")
		expect(toolCalls).toHaveLength(1)
		expect(toolCalls[0].type === "toolCall" && toolCalls[0].name).toBe("read_file")
	})

	it("re-reads the budget on every call", async () => {
		const wrapped = createThinkingBudgetStreamFn(
			async (...args) => fakeProvider(script().thinking(overBudgetText, 20)).fn(...args),
			{ isAgentTurn: agentTurn },
		)

		process.env[MAX_THINKING_TOKENS_ENV] = "0"
		expect((await collect(await wrapped(MODEL, CONTEXT, {}))).result.stopReason).toBe("stop")

		process.env[MAX_THINKING_TOKENS_ENV] = String(budget)
		expect((await collect(await wrapped(MODEL, CONTEXT, {}))).result.stopReason).toBe("length")
	})

	// message_end consumers read `usage` without guarding (llm-response-log.ts), so
	// a message missing it here would throw inside their handler.
	it("emits a well-formed message when the stream throws before any event", async () => {
		const wrapped = createThinkingBudgetStreamFn(
			async () =>
				({
					[Symbol.asyncIterator]: () => ({
						next: () => Promise.reject(new Error("transport exploded")),
					}),
					// Never resolves: the wrapper must settle from the throw alone.
					result: () => new Promise<never>(() => {}),
				}) as unknown as AssistantMessageEventStream,
			{ isAgentTurn: agentTurn, resolveBudget: () => budget },
		)

		const result = await (await wrapped(MODEL, CONTEXT, {})).result()

		expect(result.role).toBe("assistant")
		expect(result.stopReason).toBe("error")
		expect(result.errorMessage).toBe("transport exploded")
		expect(result.usage.totalTokens).toBe(0)
		expect(result.model).toBe(MODEL.id)
	})

	it("falls back to the last partial when the provider ignores the abort", async () => {
		const built = script().thinking(overBudgetText, 20)
		const provider = fakeProvider(built, { ignoreAbort: true })
		const wrapped = createThinkingBudgetStreamFn(provider.fn, {
			isAgentTurn: agentTurn,
			resolveBudget: () => budget,
			drainTimeoutMs: 20,
		})

		const stream = await wrapped(MODEL, CONTEXT, {})
		// Do not drain the iterator — result() alone must still settle, or a
		// provider that ignores the signal would hang the run forever.
		const result = await stream.result()
		expect(result.stopReason).toBe("length")
	})
})

describe("suppressThinkingBudgetForNextTurn", () => {
	const budget = 10
	const overBudgetText = "t".repeat(budget * CHARS_PER_TOKEN + 200)

	function wrapped() {
		return createThinkingBudgetStreamFn(
			async (...args) => fakeProvider(script().thinking(overBudgetText, 20)).fn(...args),
			{ isAgentTurn: agentTurn, resolveBudget: () => budget },
		)
	}

	it("exempts exactly one turn, then caps again", async () => {
		const stream = wrapped()
		suppressThinkingBudgetForNextTurn()

		expect((await collect(await stream(MODEL, CONTEXT, {}))).result.stopReason).toBe("stop")
		expect((await collect(await stream(MODEL, CONTEXT, {}))).result.stopReason).toBe("length")
	})

	// Otherwise a compaction running between the give-up and the retry would eat
	// the exemption, and the turn it was meant for would be cut off again.
	it("is not consumed by a non-agent turn", async () => {
		const capped = wrapped()
		const summarization = createThinkingBudgetStreamFn(
			async (...args) => fakeProvider(script().thinking(overBudgetText, 20)).fn(...args),
			{ isAgentTurn: () => false, resolveBudget: () => budget },
		)

		suppressThinkingBudgetForNextTurn()
		await collect(await summarization(MODEL, CONTEXT, {}))

		expect((await collect(await capped(MODEL, CONTEXT, {}))).result.stopReason).toBe("stop")
	})
})

describe("createThinkingBudgetStreamFn — genuine cancellation", () => {
	// Rewriting a user's Esc into "length" would make the agent loop carry on
	// after the run was told to stop.
	it("passes an aborted turn through as aborted, not length", async () => {
		const caller = new AbortController()
		const built = script().thinking("t".repeat(4_000), 20)
		const provider = fakeProvider(built)
		const wrapped = createThinkingBudgetStreamFn(provider.fn, {
			isAgentTurn: agentTurn,
			resolveBudget: () => 10,
		})

		const stream = await wrapped(MODEL, CONTEXT, { signal: caller.signal })
		caller.abort()
		const { result } = await collect(stream)

		expect(result.stopReason).toBe("aborted")
	})

	it("forwards an already-aborted caller signal inward", async () => {
		const caller = new AbortController()
		caller.abort()
		const provider = fakeProvider(script().thinking("hi"))
		const wrapped = createThinkingBudgetStreamFn(provider.fn, {
			isAgentTurn: agentTurn,
			resolveBudget: () => 1000,
		})

		await collect(await wrapped(MODEL, CONTEXT, { signal: caller.signal }))
		expect(provider.spy.sawSignal?.aborted).toBe(true)
	})
})

describe("installThinkingBudgetPatch", () => {
	function fakeSessionClass() {
		const calls: string[] = []
		class FakeSession {
			agent: { streamFn: unknown; signal?: AbortSignal }
			constructor() {
				this.agent = { streamFn: async () => createAssistantMessageEventStream() }
				;(this as unknown as { _installAgentToolHooks: () => void })._installAgentToolHooks()
			}
			_installAgentToolHooks() {
				calls.push("original")
			}
		}
		return { FakeSession, calls }
	}

	it("wraps each session's stream function exactly once", () => {
		const { FakeSession, calls } = fakeSessionClass()
		installThinkingBudgetPatch({ sessionClass: FakeSession as never })
		installThinkingBudgetPatch({ sessionClass: FakeSession as never })

		const session = new FakeSession()
		const wrappedOnce = session.agent.streamFn
		// Re-running the hook on the same agent must not nest another wrapper.
		;(session as unknown as { _installAgentToolHooks: () => void })._installAgentToolHooks()

		expect(session.agent.streamFn).toBe(wrappedOnce)
		expect(calls.filter((c) => c === "original")).toHaveLength(2)
	})

	it("throws a named error when the upstream internals it depends on are gone", () => {
		class Incompatible {}
		expect(() => installThinkingBudgetPatch({ sessionClass: Incompatible as never })).toThrow(
			/AgentSession._installAgentToolHooks/,
		)
	})
})
