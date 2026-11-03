import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { type AssistantMessage, createAssistantMessageEventStream, type ProviderHeaders } from "@earendil-works/pi-ai"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createModel } from "../__mocks__/model-registry.js"
import * as ledger from "../pr-cost-reporting/ledger/records.js"
import { pinProviderUsage, prepareProviderRequest, recordProviderRequest, setWorkId } from "../work-attribution.js"
import { createNativeUsageCapture, withNativeUsage } from "./native-usage.js"

let dir: string
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kimchi-native-usage-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", dir)
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	rmSync(dir, { recursive: true, force: true })
})
function captured() {
	return ledger
		.backendFor(dir)
		.readRecords({})
		.map((row) => JSON.parse(row.body))
		.filter((row) => row.nativeUsage)
}
function result(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "test",
		model: "requested",
		stopReason: "stop",
		timestamp: Date.now(),
		durationMs: 25,
		usage: {
			input: 100,
			output: 7,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 107,
			cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
		},
	}
}
function tracked(api = "openai-completions") {
	const model = { ...createModel("requested", "test"), api }
	const ctx = createContext({ cwd: dir })
	const request = recordProviderRequest(ctx, model)
	const capture = createNativeUsageCapture(model)
	capture.bind(request.requestId)
	const dispatch = () => {
		const headers = new Headers({ "X-Request-Id": request.requestId })
		prepareProviderRequest(headers, "", { bodyTags: [] })
		return headers.get("X-Request-Id")
	}
	return { capture, model, ctx, request, dispatch }
}

it("joins actual SDK retries and raw stream usage in SQLite after switching sessions and reopening", () => {
	const driver = fileURLToPath(new URL("../../../tests/e2e/tui/support/ledger-driver.ts", import.meta.url))
	const { original, calls, stopReason, captured } = JSON.parse(
		execFileSync("bun", [driver, "native-usage", dir], { encoding: "utf8", timeout: 30_000 }),
	)
	expect(stopReason).toBe("stop")
	expect(calls).toHaveLength(2)
	expect(calls.every((call: { persisted: boolean }) => call.persisted)).toBe(true)
	expect(calls[0].id).toBe(original.requestId)
	expect(calls[1].id).not.toBe(original.requestId)
	expect(captured).toEqual([
		expect.objectContaining({
			workId: original.workId,
			sessionId: "sdk-original",
			requestId: calls[1].id,
			nativeUsage: expect.objectContaining({
				finalized: true,
				finalUsageObserved: true,
				dispatchObserved: true,
				responseId: "chat-sdk",
				actualModel: "sdk-responding",
				raw: { inputTokens: 100, outputTokens: 7 },
			}),
		}),
	])
})

it("retains flat Anthropic attempt usage without aggregating models or copying opaque fields", () => {
	const { capture, model, dispatch } = tracked("anthropic-messages")
	dispatch()
	capture.onProviderStreamEvent(
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: {
				input_tokens: 12,
				output_tokens: 7,
				fallback_credit_token: "opaque-credit-must-stay-out",
				iterations: [
					{ type: "message", model: "primary", input_tokens: 10, output_tokens: 0 },
					{
						type: "fallback_message",
						model: "fallback",
						input_tokens: 12,
						output_tokens: 7,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 9,
						cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 5 },
						fallback_credit_token: "nested-credit-must-stay-out",
						stop_reason: "not-an-iteration-field",
					},
					{ type: "advisor_message", model: null, input_tokens: 3, output_tokens: 2 },
					{ type: "compaction", input_tokens: 2, output_tokens: 1 },
				],
			},
		},
		model,
	)
	capture.finish(result())
	const usage = captured()[0].nativeUsage
	expect(usage.iterations).toEqual([
		{ type: "message", model: "primary", raw: { inputTokens: 10, outputTokens: 0 } },
		{
			type: "fallback_message",
			model: "fallback",
			raw: {
				inputTokens: 12,
				outputTokens: 7,
				cacheReadTokens: 0,
				cacheWriteTokens: 9,
				cacheWrites: [
					{ ttlSeconds: 300, tokens: 4 },
					{ ttlSeconds: 3600, tokens: 5 },
				],
			},
		},
		{ type: "advisor_message", raw: { inputTokens: 3, outputTokens: 2 } },
		{ type: "compaction", raw: { inputTokens: 2, outputTokens: 1 } },
	])
	expect(usage.raw).toEqual({ inputTokens: 12, outputTokens: 7 })
	expect(usage.finalUsageObserved).toBe(true)
	expect(usage.iterationsIncomplete).toBeUndefined()
	expect(JSON.stringify(usage)).not.toContain("must-stay-out")
	expect(JSON.stringify(usage)).not.toContain("not-an-iteration-field")
})

it("retains reported iterations through the actual Anthropic SDK, retry and SQLite reopen", () => {
	const driver = fileURLToPath(new URL("../../../tests/e2e/tui/support/ledger-driver.ts", import.meta.url))
	const { original, calls, stopReason, captured } = JSON.parse(
		execFileSync("bun", [driver, "native-usage-anthropic", dir], { encoding: "utf8", timeout: 30_000 }),
	)
	expect(stopReason).toBe("stop")
	expect(calls).toHaveLength(2)
	expect(calls.every((call: { persisted: boolean }) => call.persisted)).toBe(true)
	expect(calls[0].id).toBe(original.requestId)
	expect(calls[1].id).not.toBe(original.requestId)
	expect(captured).toHaveLength(1)
	expect(captured[0]).toMatchObject({
		workId: original.workId,
		sessionId: "sdk-original",
		requestId: calls[1].id,
		nativeUsage: {
			finalUsageObserved: true,
			dispatchObserved: true,
			raw: { inputTokens: 90, outputTokens: 7 },
			iterations: [
				{ type: "message", model: "sdk-primary", raw: { inputTokens: 100, outputTokens: 0 } },
				{ type: "fallback_message", model: "sdk-fallback", raw: { inputTokens: 90, outputTokens: 7 } },
			],
		},
	})
})

it("retains known iteration evidence across omitted/null updates and later malformed reports", () => {
	const { capture, model, dispatch } = tracked("anthropic-messages")
	dispatch()
	const iteration = { type: "message", model: "primary", input_tokens: 10, output_tokens: 0 }
	for (const usage of [
		{ iterations: [iteration] },
		{ iterations: null },
		{ iterations: [] },
		{ output_tokens: 7 },
		{ iterations: "damaged" },
		{ iterations: [iteration] },
	])
		capture.onProviderStreamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage }, model)
	capture.finish(result())
	expect(captured()[0].nativeUsage).toMatchObject({
		iterations: [{ type: "message", model: "primary", raw: { inputTokens: 10, outputTokens: 0 } }],
		iterationsIncomplete: true,
	})
})

it.each([
	["empty", []],
	["malformed", [null, { type: "message", input_tokens: 5 }]],
	["unknown type", [{ type: "future_attempt", input_tokens: 5 }]],
	["oversized", Array.from({ length: 17 }, () => ({ type: "message", input_tokens: 5 }))],
])("marks %s iteration evidence incomplete without truncating known attempts", (_name, iterations) => {
	const { capture, model, dispatch } = tracked("anthropic-messages")
	dispatch()
	capture.onProviderStreamEvent({ type: "message_delta", usage: { iterations } }, model)
	capture.finish(result())
	const usage = captured()[0].nativeUsage
	expect(usage.iterationsIncomplete).toBe(true)
	expect(usage.iterations).toHaveLength(iterations.length)
	if (iterations[0] === null) expect(usage.iterations[0]).toEqual({ raw: {} })
})

it.each(["response", "retry"])("resets iteration evidence on a new %s and retains the previous attempt", (kind) => {
	const { capture, model, dispatch } = tracked("anthropic-messages")
	dispatch()
	capture.onProviderStreamEvent({ type: "message_start", message: { id: "first" } }, model)
	capture.onProviderStreamEvent({ type: "message_delta", usage: { iterations: [{ type: "message" }, null] } }, model)
	if (kind === "retry") dispatch()
	capture.onProviderStreamEvent({ type: "message_start", message: { id: "second" } }, model)
	capture.finish(result())
	const rows = captured()
	const current = rows.at(-1).nativeUsage
	const previous = kind === "retry" ? rows[0].nativeUsage : current.previousResponses[0]
	expect(current.iterations).toBeUndefined()
	expect(current.iterationsIncomplete).toBeUndefined()
	expect(previous.iterations).toEqual([{ type: "message", raw: {} }, { raw: {} }])
	expect(previous.iterationsIncomplete).toBe(true)
})

it("retains Anthropic input/cache counters while requiring the terminal event's own output usage", () => {
	const { capture, model, dispatch } = tracked("anthropic-messages")
	dispatch()
	capture.onProviderStreamEvent(
		{
			type: "message_start",
			message: {
				id: "msg-final",
				usage: {
					input_tokens: 100,
					output_tokens: 1,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 9,
					cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 5 },
				},
			},
		},
		model,
	)
	capture.onProviderStreamEvent(
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
		model,
	)
	capture.onProviderStreamEvent({ type: "message_stop" }, model)
	capture.finish(result())
	expect(captured()[0].nativeUsage).toMatchObject({
		finalUsageObserved: true,
		raw: {
			inputTokens: 100,
			outputTokens: 7,
			cacheReadTokens: 0,
			cacheWriteTokens: 9,
			cacheWrites: [
				{ ttlSeconds: 300, tokens: 4 },
				{ ttlSeconds: 3600, tokens: 5 },
			],
		},
	})
})

it("does not use a misplaced top-level Anthropic stop reason as a terminal witness", () => {
	const { capture, model, dispatch } = tracked("anthropic-messages")
	dispatch()
	capture.onProviderStreamEvent({ type: "message_delta", stop_reason: "end_turn", usage: { output_tokens: 7 } }, model)
	capture.finish(result())
	expect(captured()[0].nativeUsage.finalUsageObserved).not.toBe(true)
})

it.each([
	["openai-responses", "response.completed"],
	["openai-responses", "response.incomplete"],
	["openai-responses", "response.failed"],
	["azure-openai-responses", "response.completed"],
	["azure-openai-responses", "response.incomplete"],
	["azure-openai-responses", "response.failed"],
	["openai-codex-responses", "response.completed"],
	["openai-codex-responses", "response.incomplete"],
	["openai-codex-responses", "response.failed"],
	["openai-codex-responses", "response.done"],
])("observes final raw usage for %s %s", (api, type) => {
	const { capture, model, dispatch } = tracked(api)
	dispatch()
	capture.onProviderStreamEvent(
		{ type, response: { id: "resp-final", usage: { input_tokens: 100, output_tokens: 7 } } },
		model,
	)
	capture.finish(result())
	expect(captured()[0].nativeUsage.finalUsageObserved).toBe(true)
	expect(captured()[0].nativeUsage.raw).toEqual({ inputTokens: 100, outputTokens: 7 })
})

it.each([
	[
		"Anthropic start only",
		"anthropic-messages",
		[{ type: "message_start", message: { id: "msg", usage: { input_tokens: 100, output_tokens: 1 } } }],
	],
	[
		"Anthropic stop without usage",
		"anthropic-messages",
		[{ type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1 } } }, { type: "message_stop" }],
	],
	[
		"Anthropic terminal without own output",
		"anthropic-messages",
		[
			{ type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1 } } },
			{ type: "message_delta", delta: { stop_reason: "end_turn" } },
		],
	],
	[
		"Anthropic invalid terminal output",
		"anthropic-messages",
		[{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: -1 } }],
	],
	[
		"Chat inline usage",
		"openai-completions",
		[{ choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 7 } }],
	],
	[
		"Chat missing own input",
		"openai-completions",
		[{ usage: { prompt_tokens: 100 } }, { choices: [], usage: { completion_tokens: 7 } }],
	],
	[
		"Responses status without usage",
		"openai-responses",
		[
			{ type: "response.in_progress", response: { usage: { input_tokens: 100, output_tokens: 1 } } },
			{ type: "response.completed", response: { status: "completed" } },
		],
	],
	[
		"Responses missing own input",
		"openai-responses",
		[
			{ type: "response.in_progress", response: { usage: { input_tokens: 100, output_tokens: 1 } } },
			{ type: "response.completed", response: { usage: { output_tokens: 7 } } },
		],
	],
])("does not infer final usage from %s", (_name, api, events) => {
	const { capture, model, dispatch } = tracked(api)
	dispatch()
	for (const event of events) capture.onProviderStreamEvent(event, model)
	capture.finish(result())
	expect(captured()[0].nativeUsage.finalized).toBe(true)
	expect(captured()[0].nativeUsage.finalUsageObserved).not.toBe(true)
})

it("retains each physical attempt's witness independently of the final logical attempt", () => {
	const { capture, model, dispatch } = tracked()
	const first = dispatch()
	capture.onProviderStreamEvent(
		{ id: "chat-first", choices: [], usage: { prompt_tokens: 100, completion_tokens: 7 } },
		model,
	)
	const retry = dispatch()
	capture.onProviderStreamEvent({ id: "chat-second", usage: { prompt_tokens: 12 } }, model)
	capture.finish(result())
	expect(
		captured().map((row) => [row.requestId, row.nativeUsage.finalized, row.nativeUsage.finalUsageObserved]),
	).toEqual([
		[first, false, true],
		[retry, true, undefined],
	])
})

it("resets final usage when the response identity changes and retains the previous witness", () => {
	const { capture, model, dispatch } = tracked("openai-codex-responses")
	dispatch()
	capture.onProviderStreamEvent(
		{ type: "response.done", response: { id: "resp-first", usage: { input_tokens: 100, output_tokens: 7 } } },
		model,
	)
	capture.onProviderStreamEvent({ type: "response.created", response: { id: "resp-second" } }, model)
	capture.finish(result())
	const usage = captured()[0].nativeUsage
	expect(usage.finalUsageObserved).not.toBe(true)
	expect(usage.previousResponses[0].finalUsageObserved).toBe(true)
	expect(usage.responseCorrelation).toBe("ambiguous")
})

it("invalidates a final witness when later raw counters have no final aggregate marker", () => {
	const { capture, model, dispatch } = tracked()
	dispatch()
	capture.onProviderStreamEvent({ id: "chat", choices: [], usage: { prompt_tokens: 100, completion_tokens: 7 } }, model)
	capture.onProviderStreamEvent({ id: "chat", usage: { completion_tokens: 8 } }, model)
	capture.finish(result())
	expect(captured()[0].nativeUsage.finalUsageObserved).not.toBe(true)
	expect(captured()[0].nativeUsage.raw.outputTokens).toBe(8)
})

it("keeps initial counters partial after an early error", async () => {
	const { capture, model, dispatch } = tracked("anthropic-messages")
	dispatch()
	capture.onProviderStreamEvent(
		{ type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1 } } },
		model,
	)
	await expect(
		capture.complete(async () => {
			throw new Error("stream failed")
		}),
	).rejects.toThrow("stream failed")
	expect(captured()[0].nativeUsage).toMatchObject({ finalized: true, raw: { inputTokens: 100, outputTokens: 1 } })
	expect(captured()[0].nativeUsage.finalUsageObserved).not.toBe(true)
})

it.each([false, true])("observes the original physical runtime stream once (virtual: %s)", async (virtual) => {
	const model = createModel("requested", "test")
	const ctx = createContext({ cwd: dir })
	const runtime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: join(dir, "models.json"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	})
	const source = createAssistantMessageEventStream()
	const resultCalls = vi.spyOn(source, "result")
	const jobs: Promise<void>[] = []
	const raw = { usage: { prompt_tokens: 100, completion_tokens: 7 } }
	const transform = vi.fn((headers: ProviderHeaders) => ({
		...headers,
		"X-Test": "preserved",
		"X-Request-Id": recordProviderRequest(ctx, model).requestId,
	}))
	const observer = vi.fn()
	const options = { transformHeaders: transform, onProviderStreamEvent: observer }
	const original = vi.fn<ModelRuntime["streamSimple"]>((selected, context, providerOptions) => {
		if (selected.api === "pi-virtual") return runtime.streamSimple(model, context, providerOptions)
		jobs.push(
			(async () => {
				const headers = (await providerOptions?.transformHeaders?.({})) ?? {}
				const wire = new Headers()
				for (const [name, value] of Object.entries(headers)) {
					if (value === null) wire.delete(name)
					else wire.set(name, value)
				}
				expect(wire.get("X-Test")).toBe("preserved")
				prepareProviderRequest(wire, "", { bodyTags: [] })
				await providerOptions?.onProviderStreamEvent?.(raw, model)
				source.push({ type: "done", reason: "stop", message: result() })
				source.end()
			})(),
		)
		return source
	})
	runtime.streamSimple = original
	const create = withNativeUsage(async () => runtime)
	await create()
	const decorated = runtime.streamSimple
	await withNativeUsage(async () => runtime)()
	expect(runtime.streamSimple).toBe(decorated)
	const returned = runtime.streamSimple(virtual ? { ...model, api: "pi-virtual" } : model, { messages: [] }, options)
	expect(returned).toBe(source)
	await jobs[0]
	const events: string[] = []
	for await (const event of returned) events.push(event.type)
	expect(events).toEqual(["done"])
	await expect(returned.result()).resolves.toMatchObject({ stopReason: "stop" })
	expect(resultCalls).toHaveBeenCalledTimes(2)
	expect(transform).toHaveBeenCalledOnce()
	expect(observer).toHaveBeenCalledExactlyOnceWith(raw, model)
	expect(captured()).toHaveLength(1)
	expect(captured()[0].nativeUsage.raw).toEqual({ inputTokens: 100, outputTokens: 7 })
	if (virtual) expect(original.mock.calls[0][2]).toBe(options)
})

it.each(["sync", "async"])("keeps raw usage when the composed observer has a %s failure", async (kind) => {
	const model = createModel("requested", "test")
	const ctx = createContext({ cwd: dir })
	const runtime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: join(dir, "models.json"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	})
	const source = createAssistantMessageEventStream()
	let prepared: Parameters<ModelRuntime["streamSimple"]>[2]
	runtime.streamSimple = (_model, _context, options) => {
		prepared = options
		return source
	}
	await withNativeUsage(async () => runtime)()
	const request = recordProviderRequest(ctx, model)
	const failure = new Error("original observer failure")
	const stream = runtime.streamSimple(
		model,
		{ messages: [] },
		{
			transformHeaders: () => ({ "X-Request-Id": request.requestId }),
			onProviderStreamEvent: () => {
				if (kind === "sync") throw failure
				return Promise.reject(failure)
			},
		},
	)
	if (!prepared?.onProviderStreamEvent) throw new Error("Missing composed callbacks")
	await prepared.transformHeaders?.({})
	await expect(
		prepared.onProviderStreamEvent({ usage: { prompt_tokens: 12, completion_tokens: 3 } }, model),
	).rejects.toBe(failure)
	source.end({ ...result(), stopReason: "error" })
	await expect(stream.result()).resolves.toMatchObject({ stopReason: "error" })
	expect(captured()[0].nativeUsage.raw).toEqual({ inputTokens: 12, outputTokens: 3 })
})

it.each(["sync", "async"])("releases a completion without changing its %s failure", async (kind) => {
	const { capture, request, ctx, model, dispatch } = tracked()
	dispatch()
	const failure = new Error("provider failure")
	await expect(
		capture.complete(() => {
			if (kind === "sync") throw failure
			return Promise.reject(failure)
		}),
	).rejects.toBe(failure)
	expect(captured()).toHaveLength(1)
	const ignore = vi.spyOn(ledger, "capture").mockImplementation(() => {})
	for (let index = 0; index < 1001; index++) recordProviderRequest(ctx, model)
	ignore.mockRestore()
	expect(pinProviderUsage(request.requestId)).toBeUndefined()
})

it("records a late completion before a caller can parse or discard it", async () => {
	const { capture, model, dispatch } = tracked()
	dispatch()
	let finish!: (message: AssistantMessage) => void
	const operation = capture.complete(
		() =>
			new Promise<AssistantMessage>((resolve) => {
				finish = resolve
			}),
	)
	await expect(Promise.race([operation, Promise.resolve("deadline")])).resolves.toBe("deadline")
	capture.onProviderStreamEvent({ usage: { prompt_tokens: 100, completion_tokens: 7 } }, model)
	const message = result()
	finish(message)
	expect(await operation).toBe(message)
	expect(captured()).toHaveLength(1)
})

it("keeps omitted cache counters unknown despite SDK default zeros", () => {
	const { capture, model, dispatch } = tracked()
	dispatch()
	const event = {
		id: "chat-observed",
		model: "responding",
		usage: { prompt_tokens: 100, completion_tokens: 7 },
		prompt: "private prompt",
		choices: [{ delta: { content: "private answer" } }],
	}
	capture.onProviderStreamEvent(event, model)
	capture.finish(result())
	const usage = captured()[0].nativeUsage
	expect(usage).toMatchObject({
		schema: "openai-chat-completions-v1",
		raw: { inputTokens: 100, outputTokens: 7 },
		actualModel: "responding",
		responseId: "chat-observed",
		billingBasis: "unknown",
		dispatchObserved: true,
		sdkUsage: { cacheRead: 0, cacheWrite: 0 },
	})
	expect(usage.raw).toEqual({ inputTokens: 100, outputTokens: 7 })
	expect(JSON.stringify(usage)).not.toContain("private")
})

it("preserves reported zeros, inclusive input and reasoning as an output subset", () => {
	const { capture, model, dispatch } = tracked()
	dispatch()
	capture.onProviderStreamEvent(
		{
			service_tier: "priority",
			usage: {
				prompt_tokens: 100,
				completion_tokens: 7,
				prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
				completion_tokens_details: { reasoning_tokens: 3 },
			},
		},
		model,
	)
	capture.finish(result())
	expect(captured()[0].nativeUsage).toMatchObject({
		serviceTier: "priority",
		raw: {
			inputTokens: 100,
			outputTokens: 7,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 3,
		},
	})
})

it("merges Anthropic cumulative deltas without summing usage or losing TTL buckets", () => {
	const { capture, model, dispatch } = tracked("anthropic-messages")
	dispatch()
	capture.onProviderStreamEvent(
		{
			type: "message_start",
			message: {
				id: "msg-observed",
				model: "claude-observed",
				service_tier: "ignore-top-level",
				usage: {
					input_tokens: 100,
					output_tokens: 1,
					service_tier: "standard",
					inference_geo: "global",
					cache_read_input_tokens: 10,
					cache_creation_input_tokens: 6,
					cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 2 },
				},
			},
		},
		model,
	)
	for (const output_tokens of [5, 7])
		capture.onProviderStreamEvent(
			{ type: "message_delta", usage: { output_tokens, service_tier: null, inference_geo: null } },
			model,
		)
	capture.finish()
	expect(captured()[0].nativeUsage).toMatchObject({
		schema: "anthropic-messages-v1",
		responseId: "msg-observed",
		actualModel: "claude-observed",
		serviceTier: "standard",
		region: "global",
		raw: {
			inputTokens: 100,
			outputTokens: 7,
			cacheReadTokens: 10,
			cacheWriteTokens: 6,
			cacheWrites: [
				{ ttlSeconds: 300, tokens: 4 },
				{ ttlSeconds: 3600, tokens: 2 },
			],
		},
	})
})

it.each([
	{},
	{ service_tier: 1, inference_geo: false },
])("keeps Anthropic pricing dimensions with their observed response when the next omits valid values: %j", (nextUsage) => {
	const { capture, model, dispatch } = tracked("anthropic-messages")
	dispatch()
	capture.onProviderStreamEvent(
		{
			type: "message_start",
			message: { id: "msg-first", usage: { service_tier: "priority", inference_geo: "us" } },
		},
		model,
	)
	capture.onProviderStreamEvent(
		{ type: "message_start", message: { id: "msg-second", usage: { input_tokens: 10, ...nextUsage } } },
		model,
	)
	capture.finish()
	const usage = captured()[0].nativeUsage
	expect(usage).toMatchObject({ responseId: "msg-second", responseCorrelation: "ambiguous" })
	expect(usage.serviceTier).toBeUndefined()
	expect(usage.region).toBeUndefined()
	expect(usage.previousResponses).toEqual([
		expect.objectContaining({ responseId: "msg-first", serviceTier: "priority", region: "us" }),
	])
})

it.each([
	["openai-responses", "response.completed"],
	["azure-openai-responses", "response.incomplete"],
	["openai-codex-responses", "response.done"],
	["openai-codex-responses", "response.failed"],
])("retains raw terminal usage and responding metadata for %s / %s", (api, type) => {
	const { capture, model } = tracked(api)
	capture.onProviderStreamEvent(
		{
			type,
			response: {
				id: "resp-observed",
				model: "actual-response-model",
				service_tier: "flex",
				status: "incomplete",
				incomplete_details: { reason: "max_output_tokens" },
				usage: {
					input_tokens: 100,
					output_tokens: 7,
					input_tokens_details: { cached_tokens: 4, cache_write_tokens: 0 },
					output_tokens_details: { reasoning_tokens: 3 },
				},
			},
		},
		model,
	)
	capture.finish()
	expect(captured()[0].nativeUsage).toMatchObject({
		api,
		schema: "openai-responses-v1",
		billingBasis: "unknown",
		dispatchObserved: false,
		actualModel: "actual-response-model",
		responseId: "resp-observed",
		serviceTier: "flex",
		responseStatus: "incomplete",
		incompleteReason: "max_output_tokens",
		raw: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 4, cacheWriteTokens: 0, reasoningTokens: 3 },
	})
})

it("does not mix counters from distinct Codex responses without an observed new dispatch", () => {
	const { capture, model } = tracked("openai-codex-responses")
	capture.onProviderStreamEvent(
		{
			type: "response.failed",
			response: {
				id: "resp-first",
				model: "first-model",
				service_tier: "priority",
				status: "failed",
				error: { code: "previous_response_not_found" },
				usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 50, cache_write_tokens: 0 } },
			},
		},
		model,
	)
	capture.onProviderStreamEvent({ type: "response.created", response: { id: "resp-second" } }, model)
	capture.onProviderStreamEvent(
		{
			type: "response.done",
			response: {
				id: "resp-second",
				usage: { input_tokens: 200, output_tokens: 7 },
			},
		},
		model,
	)
	capture.finish({ ...result(), responseId: "resp-first", responseModel: "first-model" })
	const usage = captured()[0].nativeUsage
	expect(usage.raw).toEqual({ inputTokens: 200, outputTokens: 7 })
	expect(usage).toMatchObject({ responseId: "resp-second", responseCorrelation: "ambiguous", dispatchObserved: false })
	expect(usage.actualModel).toBeUndefined()
	expect(usage.serviceTier).toBeUndefined()
	expect(usage.responseStatus).toBeUndefined()
	expect(usage.previousResponses).toEqual([
		expect.objectContaining({
			responseId: "resp-first",
			actualModel: "first-model",
			serviceTier: "priority",
			responseStatus: "failed",
			raw: { inputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 0 },
		}),
	])
})

it("keeps raw partial attempts separate from the retry's final result and original work", () => {
	const { capture, model, ctx, request, dispatch } = tracked()
	const first = dispatch()
	capture.onProviderStreamEvent({ usage: { prompt_tokens: 12 } }, model)
	setWorkId(ctx)
	const retry = dispatch()
	capture.onProviderStreamEvent({ usage: { prompt_tokens: 100, completion_tokens: 7 } }, model)
	capture.finish(result())
	expect(captured().map((row) => [row.requestId, row.workId, row.nativeUsage.finalized, row.nativeUsage.raw])).toEqual([
		[first, request.workId, false, { inputTokens: 12 }],
		[retry, request.workId, true, { inputTokens: 100, outputTokens: 7 }],
	])
})

it.each([
	"openai-completions",
	"unsupported-api",
])("does not synthesize raw usage without an observer for %s", (api) => {
	const { capture, dispatch } = tracked(api)
	dispatch()
	capture.finish(result())
	expect(captured()[0].nativeUsage.raw).toEqual({})
	expect(captured()[0].nativeUsage.api).toBe(api)
	if (api === "unsupported-api") expect(captured()[0].nativeUsage.schema).toBe("unknown")
})

it("does not retain invalid counters or mutate the provider event", () => {
	const { capture, model, dispatch } = tracked()
	dispatch()
	const event = Object.freeze({
		usage: Object.freeze({
			prompt_tokens: -1,
			completion_tokens: 1.5,
			prompt_tokens_details: Object.freeze({ cached_tokens: "0", cache_write_tokens: Number.NaN }),
		}),
	})
	capture.onProviderStreamEvent(event, model)
	capture.finish(result())
	expect(captured()[0].nativeUsage.raw).toEqual({})
	expect(event.usage.prompt_tokens).toBe(-1)
})

it.each([false, true])("finishes silently and releases once, including persistence failure: %s", (fail) => {
	const { capture, model, ctx, request, dispatch } = tracked()
	capture.bind(request.requestId)
	dispatch()
	capture.onProviderStreamEvent({ usage: { prompt_tokens: 10 } }, model)
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
	const error = vi.spyOn(console, "error").mockImplementation(() => {})
	const store = ledger.backendFor(dir)
	const write = fail
		? vi.spyOn(store, "insertRecord").mockImplementation(() => {
				throw new Error("unavailable")
			})
		: undefined
	expect(() => capture.finish(result())).not.toThrow()
	write?.mockRestore()
	capture.finish(result())
	capture.onProviderStreamEvent({ usage: { prompt_tokens: 99 } }, model)
	expect(captured()).toHaveLength(fail ? 0 : 1)
	const ignore = vi.spyOn(ledger, "capture").mockImplementation(() => {})
	for (let index = 0; index < 1001; index++) recordProviderRequest(ctx, model)
	ignore.mockRestore()
	expect(pinProviderUsage(request.requestId)).toBeUndefined()
	expect(warning).not.toHaveBeenCalled()
	expect(error).not.toHaveBeenCalled()
})
