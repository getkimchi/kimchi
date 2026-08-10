import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { type CompletePhysicalModel, PhysicalModelInvoker } from "./physical-invoker.js"
import { CouncilRunContext } from "./run-context.js"

const model: Model<Api> = {
	id: "physical",
	name: "physical",
	api: "openai-completions",
	provider: "physical",
	baseUrl: "http://localhost.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768,
	maxTokens: 4_096,
}

const limits = {
	overallTimeoutMs: 10_000,
	maxLogicalCalls: 10,
	maxPhysicalAttempts: 10,
	maxConcurrentCalls: 2,
	maxAggregateInputTokens: 10_000,
	maxAggregateOutputTokens: 10_000,
	maxEvidenceBytes: 10_000,
	maxStructuredBytes: 10_000,
}

const context: Context = { messages: [{ role: "user", content: "solve", timestamp: 1 }] }

describe("Council runtime boundaries", () => {
	it("keeps virtual credentials out of physical calls", async () => {
		const completeModel = vi.fn<CompletePhysicalModel>(async (physical) => ({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: physical.api,
			provider: physical.provider,
			model: physical.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		}))
		const registry = {
			find: vi.fn(() => model),
			getApiKeyAndHeaders: vi.fn(async () => ({
				ok: true as const,
				apiKey: "physical-key",
				headers: { authorization: "physical" },
				env: { PHYSICAL_SCOPE: "physical" },
			})),
		} satisfies Pick<ModelRegistry, "find" | "getApiKeyAndHeaders">
		const run = new CouncilRunContext(limits)
		const invoker = new PhysicalModelInvoker({ registry, completeModel, maxRetriesPerCall: 0 })

		await invoker.invoke({
			run,
			runId: "run",
			virtualModelRef: "kimchi/council",
			stage: "solver",
			pool: { primary: "physical/primary", fallbacks: [] },
			context,
			requestedMaxTokens: 100,
			stageTimeoutMs: 1_000,
			parentOptions: {
				apiKey: "virtual-key",
				headers: { authorization: "virtual" },
				env: { VIRTUAL_SCOPE: "virtual" },
			} as SimpleStreamOptions,
		})

		const options = completeModel.mock.calls[0]?.[2] as SimpleStreamOptions
		expect(options.apiKey).toBe("physical-key")
		expect(options.headers).toMatchObject({ authorization: "physical" })
		expect(options.headers).not.toHaveProperty("virtual")
		expect(options.env).toEqual({ PHYSICAL_SCOPE: "physical" })
		run.close()
	})

	it("rejects a Council model pool before a child call can recurse", async () => {
		const completeModel = vi.fn<CompletePhysicalModel>()
		const registry = {
			find: vi.fn(() => undefined),
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "key" })),
		} satisfies Pick<ModelRegistry, "find" | "getApiKeyAndHeaders">
		const run = new CouncilRunContext(limits)
		const invoker = new PhysicalModelInvoker({ registry, completeModel, maxRetriesPerCall: 0 })

		await expect(
			invoker.invoke({
				run,
				runId: "run",
				virtualModelRef: "kimchi/council",
				stage: "solver",
				pool: { primary: "kimchi/council-fast", fallbacks: [] },
				context,
				requestedMaxTokens: 100,
				stageTimeoutMs: 1_000,
				parentOptions: {},
			}),
		).rejects.toThrow(/Council recursion is not allowed/i)
		expect(completeModel).not.toHaveBeenCalled()
		run.close()
	})
})
