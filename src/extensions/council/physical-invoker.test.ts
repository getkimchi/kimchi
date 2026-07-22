import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai"
import { describe, expect, it, vi } from "vitest"
import { type CompletePhysicalModel, PhysicalModelInvoker } from "./physical-invoker.js"
import { CouncilRunContext, type RunBudgetLimits } from "./run-context.js"

const limits: RunBudgetLimits = {
	overallTimeoutMs: 10_000,
	maxLogicalCalls: 5,
	maxPhysicalAttempts: 5,
	maxConcurrentCalls: 2,
	maxAggregateInputTokens: 10_000,
	maxAggregateOutputTokens: 2_000,
	maxEstimatedCostUsd: 10,
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
			stage: "checker",
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
			temperature: 0,
			reasoning: "low",
			onPayload,
			onResponse,
			metadata: {
				caller: "kept",
				"virtual-model": "kimchi/council",
				"council-run": "run-1",
				"council-stage": "checker",
				"physical-model": "physical/fallback",
			},
		})
		expect(options.maxTokens).toBeLessThanOrEqual(fallback.maxTokens)
		run.close()
	})

	it("does not use a fallback to hide an output-contract failure", async () => {
		const primary = model("primary")
		const fallback = model("fallback")
		const completeModel = vi.fn<CompletePhysicalModel>(async (physical) => response(physical, "length"))
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
			}),
		).rejects.toMatchObject({ code: "output_limit", fallbackEligible: false })
		expect(completeModel).toHaveBeenCalledOnce()
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
