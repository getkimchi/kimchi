import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai"
import { describe, expect, it, vi } from "vitest"
import {
	type CompletePhysicalModel,
	isCouncilVirtualModel,
	isCouncilVirtualModelRef,
	PhysicalModelInvoker,
} from "./physical-invoker.js"
import { CouncilRunContext, type RunBudgetLimits } from "./run-context.js"

const limits: RunBudgetLimits = {
	overallTimeoutMs: 10_000,
	maxLogicalCalls: 5,
	maxPhysicalAttempts: 5,
	maxConcurrentCalls: 2,
	maxAggregateInputTokens: 10_000,
	maxAggregateOutputTokens: 2_000,
	maxEvidenceBytes: 10_000,
	maxStructuredBytes: 10_000,
}
const usage: Usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
}
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] }

function model(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "physical",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 1_024,
	}
}

function response(physical: Model<Api>, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: physical.api,
		provider: physical.provider,
		model: physical.id,
		usage,
		stopReason,
		timestamp: 1,
	}
}

describe("PhysicalModelInvoker", () => {
	it("falls back on infrastructure failure and preserves physical request semantics", async () => {
		const primary = model("primary")
		const fallback = model("fallback")
		const onPayload = vi.fn()
		const onResponse = vi.fn()
		const completeModel = vi.fn<CompletePhysicalModel>(async (physical) => response(physical))
		const registry = {
			find: vi.fn((_provider: string, id: string) => (id === "primary" ? primary : fallback)),
			getApiKeyAndHeaders: vi.fn(async (physical: Model<Api>) =>
				physical.id === "primary"
					? { ok: false as const, error: "missing" }
					: {
							ok: true as const,
							apiKey: "physical-key",
							headers: { authorization: "physical", "x-provider": "yes" },
							env: { PHYSICAL_ENV: "yes" },
						},
			),
		}
		const run = new CouncilRunContext(limits)
		const invoker = new PhysicalModelInvoker({ registry, completeModel, maxRetriesPerCall: 0 })
		const result = await invoker.invoke({
			run,
			runId: "run-1",
			virtualModelRef: "kimchi/council",
			stage: "solver",
			pool: { primary: "physical/primary", fallbacks: ["physical/fallback"] },
			context,
			requestedMaxTokens: 4_096,
			stageTimeoutMs: 1_000,
			parentOptions: {
				headers: { authorization: "virtual", "x-session-id": "session" },
				env: { VIRTUAL_ENV: "no" },
				onPayload,
				onResponse,
				metadata: { caller: "kept", "council-run": "spoofed" },
			},
		})

		expect(result.modelRef).toBe("physical/fallback")
		expect(result.attempts).toBe(2)
		const options = completeModel.mock.calls[0]?.[2] as SimpleStreamOptions
		expect(options).toMatchObject({
			apiKey: "physical-key",
			headers: { authorization: "physical", "x-provider": "yes", "x-session-id": "session" },
			env: { PHYSICAL_ENV: "yes" },
			maxRetries: 0,
			temperature: 0.2,
			reasoning: "medium",
			onPayload,
			onResponse,
			metadata: {
				caller: "kept",
				"virtual-model": "kimchi/council",
				"council-run": "run-1",
				"council-stage": "solver",
				"physical-model": "physical/fallback",
			},
		})
		expect(options.maxTokens).toBeLessThanOrEqual(fallback.maxTokens)
		run.close()
	})

	it("falls back when a solver reaches its output limit", async () => {
		const primary = model("primary")
		const fallback = model("fallback")
		const completeModel = vi.fn<CompletePhysicalModel>(async (physical) =>
			response(physical, physical.id === "primary" ? "length" : "stop"),
		)
		const registry = {
			find: vi.fn((_provider: string, id: string) => (id === "primary" ? primary : fallback)),
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "key" })),
		}
		const run = new CouncilRunContext(limits)
		const invoker = new PhysicalModelInvoker({ registry, completeModel, maxRetriesPerCall: 1 })

		const result = await invoker.invoke({
			run,
			runId: "run",
			virtualModelRef: "kimchi/council",
			stage: "solver",
			pool: { primary: "physical/primary", fallbacks: ["physical/fallback"] },
			context,
			requestedMaxTokens: 100,
			stageTimeoutMs: 1_000,
			parentOptions: {},
		})

		expect(result).toMatchObject({ modelRef: "physical/fallback", attempts: 2 })
		expect(completeModel).toHaveBeenCalledTimes(2)
		expect(completeModel.mock.calls[0]?.[2]).toMatchObject({ reasoning: "medium" })
		run.close()
	})

	it("passes each physical model input budget into prepared context", async () => {
		const primary = { ...model("primary"), contextWindow: 2_048 }
		const fallback = { ...model("fallback"), contextWindow: 8_192 }
		const preparedBudgets: Array<{ id: string; maxInputBytes: number }> = []
		const completeModel = vi.fn<CompletePhysicalModel>(async (physical) => response(physical))
		const registry = {
			find: vi.fn((_provider: string, id: string) => (id === "primary" ? primary : fallback)),
			getApiKeyAndHeaders: vi.fn(async (physical: Model<Api>) =>
				physical.id === "primary" ? { ok: false as const, error: "missing" } : { ok: true as const, apiKey: "key" },
			),
		}
		const run = new CouncilRunContext(limits)
		const invoker = new PhysicalModelInvoker({ registry, completeModel, maxRetriesPerCall: 0 })

		await invoker.invoke({
			run,
			runId: "run",
			virtualModelRef: "kimchi/council",
			stage: "solver",
			pool: { primary: "physical/primary", fallbacks: ["physical/fallback"] },
			context,
			requestedMaxTokens: 100,
			stageTimeoutMs: 1_000,
			parentOptions: {},
			prepareContext: (physical, requestedMaxTokens, maxInputBytes) => {
				preparedBudgets.push({ id: physical.id, maxInputBytes })
				return {
					context: { messages: [{ role: "user", content: `${physical.id}:${maxInputBytes}`, timestamp: 1 }] },
					requestedMaxTokens,
				}
			},
		})

		expect(preparedBudgets.map(({ id }) => id)).toEqual(["primary", "fallback"])
		expect(preparedBudgets[1]?.maxInputBytes).toBeGreaterThan(preparedBudgets[0]?.maxInputBytes ?? 0)
		expect(completeModel.mock.calls[0]?.[1].messages[0]).toMatchObject({ content: expect.stringMatching(/^fallback:/) })
		run.close()
	})

	it("forwards text deltas and does not retry after public output", async () => {
		const primary = model("primary")
		const fallback = model("fallback")
		const deltas: Array<[string, string]> = []
		const completeModel = vi.fn<CompletePhysicalModel>(async (_physical, _context, _options, onTextDelta) => {
			onTextDelta?.("hello", "hello")
			throw new Error("stream failed")
		})
		const registry = {
			find: vi.fn((_provider: string, id: string) => (id === "primary" ? primary : fallback)),
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "key" })),
		}
		const run = new CouncilRunContext(limits)
		const invoker = new PhysicalModelInvoker({ registry, completeModel, maxRetriesPerCall: 1 })

		await expect(
			invoker.invoke({
				run,
				runId: "run",
				virtualModelRef: "kimchi/council",
				stage: "lead",
				pool: { primary: "physical/primary", fallbacks: ["physical/fallback"] },
				context,
				requestedMaxTokens: 100,
				stageTimeoutMs: 1_000,
				parentOptions: {},
				onTextDelta: (delta, fullText) => deltas.push([delta, fullText]),
			}),
		).rejects.toMatchObject({ code: "provider_error" })

		expect(deltas).toEqual([["hello", "hello"]])
		expect(completeModel).toHaveBeenCalledOnce()
		run.close()
	})

	it("uses deterministic analyst inference instead of caller sampling settings", async () => {
		const physical = model("analyst")
		const completeModel = vi.fn<CompletePhysicalModel>(async (selected) => response(selected))
		const registry = {
			find: vi.fn(() => physical),
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "key" })),
		}
		const run = new CouncilRunContext(limits)
		const invoker = new PhysicalModelInvoker({ registry, completeModel, maxRetriesPerCall: 0 })

		await invoker.invoke({
			run,
			runId: "run",
			virtualModelRef: "kimchi/council",
			stage: "analyst",
			pool: { primary: "physical/analyst", fallbacks: [] },
			context,
			requestedMaxTokens: 100,
			stageTimeoutMs: 1_000,
			parentOptions: { temperature: 0.9, reasoning: "minimal" },
		})

		expect(completeModel.mock.calls[0]?.[2]).toMatchObject({ temperature: 0, reasoning: "high" })
		run.close()
	})

	it("propagates caller cancellation to the active physical request", async () => {
		const physical = model("primary")
		const caller = new AbortController()
		let observedSignal: AbortSignal | undefined
		const completeModel = vi.fn<CompletePhysicalModel>(async (_model, _context, options) => {
			observedSignal = options?.signal
			return await new Promise<AssistantMessage>((_resolve, reject) => {
				if (!observedSignal) {
					reject(new Error("missing signal"))
					return
				}
				const onAbort = () => reject(observedSignal?.reason)
				if (observedSignal.aborted) onAbort()
				else observedSignal.addEventListener("abort", onAbort, { once: true })
			})
		})
		const registry = {
			find: vi.fn(() => physical),
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "key" })),
		}
		const run = new CouncilRunContext(limits, { callerSignal: caller.signal })
		const invoker = new PhysicalModelInvoker({ registry, completeModel, maxRetriesPerCall: 0 })
		const pending = invoker.invoke({
			run,
			runId: "run",
			virtualModelRef: "kimchi/council",
			stage: "lead",
			pool: { primary: "physical/primary", fallbacks: [] },
			context,
			requestedMaxTokens: 100,
			stageTimeoutMs: 1_000,
			parentOptions: {},
		})
		const rejected = expect(pending).rejects.toMatchObject({ code: "aborted" })

		await vi.waitFor(() => expect(completeModel).toHaveBeenCalledOnce())
		caller.abort()

		await rejected
		expect(observedSignal?.aborted).toBe(true)
		run.close()
	})

	it("falls back to the next model in the pool after a stage timeout and can still succeed", async () => {
		const primary = model("primary")
		const fallback = model("fallback")
		const completeModel = vi.fn<CompletePhysicalModel>(async (physical, _context, options) => {
			if (physical.id !== "primary") return response(physical)
			return await new Promise<AssistantMessage>((_resolve, reject) => {
				const signal = options?.signal
				if (!signal) {
					reject(new Error("missing signal"))
					return
				}
				if (signal.aborted) {
					reject(signal.reason)
					return
				}
				signal.addEventListener("abort", () => reject(signal.reason), { once: true })
			})
		})
		const registry = {
			find: vi.fn((_provider: string, id: string) => (id === "primary" ? primary : fallback)),
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "key" })),
		}
		const run = new CouncilRunContext({ ...limits, overallTimeoutMs: 2_000 })
		const invoker = new PhysicalModelInvoker({ registry, completeModel, maxRetriesPerCall: 0 })

		const result = await invoker.invoke({
			run,
			runId: "run",
			virtualModelRef: "kimchi/council",
			stage: "lead",
			pool: { primary: "physical/primary", fallbacks: ["physical/fallback"] },
			context,
			requestedMaxTokens: 100,
			stageTimeoutMs: 20,
			parentOptions: {},
		})

		expect(result).toMatchObject({ modelRef: "physical/fallback", attempts: 2 })
		run.close()
	})

	it("reports a timeout after every model in the pool times out", async () => {
		const primary = model("primary")
		const fallback = model("fallback")
		const completeModel = vi.fn<CompletePhysicalModel>(async (_physical, _context, options) => {
			return await new Promise<AssistantMessage>((_resolve, reject) => {
				const signal = options?.signal
				if (!signal) {
					reject(new Error("missing signal"))
					return
				}
				if (signal.aborted) {
					reject(signal.reason)
					return
				}
				signal.addEventListener("abort", () => reject(signal.reason), { once: true })
			})
		})
		const registry = {
			find: vi.fn((_provider: string, id: string) => (id === "primary" ? primary : fallback)),
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "key" })),
		}
		const run = new CouncilRunContext({ ...limits, overallTimeoutMs: 2_000 })
		const invoker = new PhysicalModelInvoker({ registry, completeModel, maxRetriesPerCall: 0 })

		await expect(
			invoker.invoke({
				run,
				runId: "run",
				virtualModelRef: "kimchi/council",
				stage: "lead",
				pool: { primary: "physical/primary", fallbacks: ["physical/fallback"] },
				context,
				requestedMaxTokens: 100,
				stageTimeoutMs: 15,
				parentOptions: {},
			}),
		).rejects.toMatchObject({ code: "timeout", fallbackEligible: true })

		expect(completeModel).toHaveBeenCalledTimes(2)
		run.close()
	})

	it("terminates immediately on a whole-run deadline without attempting a fallback", async () => {
		const primary = model("primary")
		const fallback = model("fallback")
		const completeModel = vi.fn<CompletePhysicalModel>(async (physical) => response(physical))
		const registry = {
			find: vi.fn((_provider: string, id: string) => (id === "primary" ? primary : fallback)),
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "key" })),
		}
		const run = new CouncilRunContext(limits, { deadlineAt: Date.now() - 1 })
		const invoker = new PhysicalModelInvoker({ registry, completeModel, maxRetriesPerCall: 0 })

		await expect(
			invoker.invoke({
				run,
				runId: "run",
				virtualModelRef: "kimchi/council",
				stage: "lead",
				pool: { primary: "physical/primary", fallbacks: ["physical/fallback"] },
				context,
				requestedMaxTokens: 100,
				stageTimeoutMs: 1_000,
				parentOptions: {},
			}),
		).rejects.toMatchObject({ code: "deadline_exceeded" })

		expect(completeModel).not.toHaveBeenCalled()
		run.close()
	})

	it("terminates immediately when the run budget is exhausted without attempting a fallback", async () => {
		const primary = model("primary")
		const fallback = model("fallback")
		const completeModel = vi.fn<CompletePhysicalModel>(async (physical) => response(physical))
		const registry = {
			find: vi.fn((_provider: string, id: string) => (id === "primary" ? primary : fallback)),
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "key" })),
		}
		const run = new CouncilRunContext({ ...limits, maxLogicalCalls: 0 })
		const invoker = new PhysicalModelInvoker({ registry, completeModel, maxRetriesPerCall: 0 })

		await expect(
			invoker.invoke({
				run,
				runId: "run",
				virtualModelRef: "kimchi/council",
				stage: "lead",
				pool: { primary: "physical/primary", fallbacks: ["physical/fallback"] },
				context,
				requestedMaxTokens: 100,
				stageTimeoutMs: 1_000,
				parentOptions: {},
			}),
		).rejects.toMatchObject({ code: "budget_exceeded" })

		expect(completeModel).not.toHaveBeenCalled()
		run.close()
	})

	it("terminates immediately on a genuine parent abort without attempting a fallback", async () => {
		const primary = model("primary")
		const fallback = model("fallback")
		const caller = new AbortController()
		let observedSignal: AbortSignal | undefined
		const completeModel = vi.fn<CompletePhysicalModel>(async (physical, _context, options) => {
			if (physical.id !== "primary") return response(physical)
			observedSignal = options?.signal
			return await new Promise<AssistantMessage>((_resolve, reject) => {
				if (!observedSignal) {
					reject(new Error("missing signal"))
					return
				}
				const onAbort = () => reject(observedSignal?.reason)
				if (observedSignal.aborted) onAbort()
				else observedSignal.addEventListener("abort", onAbort, { once: true })
			})
		})
		const registry = {
			find: vi.fn((_provider: string, id: string) => (id === "primary" ? primary : fallback)),
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "key" })),
		}
		const run = new CouncilRunContext(limits, { callerSignal: caller.signal })
		const invoker = new PhysicalModelInvoker({ registry, completeModel, maxRetriesPerCall: 0 })
		const pending = invoker.invoke({
			run,
			runId: "run",
			virtualModelRef: "kimchi/council",
			stage: "lead",
			pool: { primary: "physical/primary", fallbacks: ["physical/fallback"] },
			context,
			requestedMaxTokens: 100,
			stageTimeoutMs: 1_000,
			parentOptions: {},
		})
		const rejected = expect(pending).rejects.toMatchObject({ code: "aborted" })

		await vi.waitFor(() => expect(completeModel).toHaveBeenCalledOnce())
		caller.abort()

		await rejected
		expect(completeModel).toHaveBeenCalledTimes(1)
		run.close()
	})

	it("clamps a fallback attempt near the whole-run deadline to the remaining time instead of a full stage timeout", async () => {
		const primary = model("primary")
		const fallback = model("fallback")
		const completeModel = vi.fn<CompletePhysicalModel>(async (physical) => response(physical))
		const registry = {
			find: vi.fn((_provider: string, id: string) => (id === "primary" ? primary : fallback)),
			getApiKeyAndHeaders: vi.fn(async (physical: Model<Api>) => {
				if (physical.id !== "primary") return { ok: true as const, apiKey: "key" }
				await new Promise((resolve) => setTimeout(resolve, 350))
				return { ok: false as const, error: "missing" }
			}),
		}
		const run = new CouncilRunContext({ ...limits, overallTimeoutMs: 500 })
		const invoker = new PhysicalModelInvoker({ registry, completeModel, maxRetriesPerCall: 0 })

		const result = await invoker.invoke({
			run,
			runId: "run",
			virtualModelRef: "kimchi/council",
			stage: "lead",
			pool: { primary: "physical/primary", fallbacks: ["physical/fallback"] },
			context,
			requestedMaxTokens: 100,
			stageTimeoutMs: 5_000,
			parentOptions: {},
		})

		expect(result.modelRef).toBe("physical/fallback")
		expect(completeModel).toHaveBeenCalledOnce()
		const fallbackOptions = completeModel.mock.calls[0]?.[2] as SimpleStreamOptions
		expect(fallbackOptions.timeoutMs).toBeGreaterThan(0)
		expect(fallbackOptions.timeoutMs).toBeLessThan(250)
		run.close()
	})

	it("rejects recursive Council pools before authentication or dispatch", async () => {
		const registry = { find: vi.fn(), getApiKeyAndHeaders: vi.fn() }
		const completeModel = vi.fn<CompletePhysicalModel>()
		const run = new CouncilRunContext(limits)
		const invoker = new PhysicalModelInvoker({ registry, completeModel, maxRetriesPerCall: 0 })

		await expect(
			invoker.invoke({
				run,
				runId: "run",
				virtualModelRef: "kimchi/council",
				stage: "lead",
				pool: { primary: "kimchi/council-deep", fallbacks: [] },
				context,
				requestedMaxTokens: 100,
				stageTimeoutMs: 1_000,
				parentOptions: {},
			}),
		).rejects.toMatchObject({ code: "model_incompatible" })
		expect(registry.getApiKeyAndHeaders).not.toHaveBeenCalled()
		expect(completeModel).not.toHaveBeenCalled()
		run.close()
	})
})

describe("Council virtual model identity", () => {
	it.each([
		"council-fast",
		"council",
		"council-deep",
		"kimchi/council-fast",
		"kimchi/council",
		"kimchi/council-deep",
		"kimchi-council",
		"kimchi-council/council",
	])("recognizes %s", (modelRef) => {
		expect(isCouncilVirtualModelRef(modelRef)).toBe(true)
	})

	it.each([
		"council-ai/model",
		"kimchi/councilor",
		"kimchi/council-extra",
		"other/council",
	])("does not overmatch %s", (modelRef) => {
		expect(isCouncilVirtualModelRef(modelRef)).toBe(false)
	})

	it("uses exact model metadata", () => {
		expect(isCouncilVirtualModel({ api: "custom", provider: "council-ai", id: "model" })).toBe(false)
		expect(isCouncilVirtualModel({ api: "kimchi-council", provider: "custom", id: "model" })).toBe(true)
	})
})
