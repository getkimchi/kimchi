import type { Model } from "@earendil-works/pi-ai"
import type { CreateMessageRequest } from "@modelcontextprotocol/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	handleSamplingRequest,
	type SamplingHandlerOptions,
} from "../../../node_modules/pi-mcp-adapter/dist/sampling-handler.js"

const mocks = vi.hoisted(() => ({
	complete: vi.fn(),
	streamSimple: vi.fn(),
	result: vi.fn(),
}))

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const model = {
	provider: "anthropic",
	id: "claude-sonnet",
	api: "anthropic-messages",
	name: "Claude Sonnet",
	baseUrl: "https://api.anthropic.com",
	input: ["text"],
	reasoning: false,
	cost: usage.cost,
	contextWindow: 200000,
	maxTokens: 8192,
} satisfies Model<"anthropic-messages">

function createOptions(overrides: Partial<SamplingHandlerOptions> = {}): SamplingHandlerOptions {
	return {
		serverName: "fixture",
		autoApprove: true,
		modelRegistry: {
			getAvailable: vi.fn(() => [model]),
			complete: mocks.complete,
			streamSimple: mocks.streamSimple,
		},
		getCurrentModel: vi.fn(() => undefined),
		getThinkingLevel: vi.fn(() => "off" as const),
		getSignal: vi.fn(() => undefined),
		...overrides,
	}
}

function samplingRequest(metadata?: CreateMessageRequest["params"]["metadata"]): CreateMessageRequest {
	return {
		method: "sampling/createMessage",
		params: {
			messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
			maxTokens: 50,
			...(metadata === undefined ? {} : { metadata }),
		},
	}
}

describe("MCP sampling thinking level (compiled adapter)", () => {
	beforeEach(() => {
		mocks.result.mockReset().mockResolvedValue({
			role: "assistant",
			content: [{ type: "text", text: "Bonjour" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage,
			stopReason: "stop",
			timestamp: 1,
		})
		mocks.streamSimple.mockReset().mockImplementation(() => ({ result: mocks.result }))
		mocks.complete.mockReset().mockImplementation(() => mocks.result())
	})

	it("passes the current thinking level to streamSimple", async () => {
		await handleSamplingRequest(
			createOptions({ getThinkingLevel: () => "high" }),
			samplingRequest({ reasoning_budget: 4096 }),
		)

		expect(mocks.streamSimple.mock.calls[0]?.[2]).toEqual({
			maxTokens: 50,
			metadata: { reasoning_budget: 4096 },
			reasoning: "high",
		})
	})

	it("omits reasoning when the current thinking level is off", async () => {
		await handleSamplingRequest(createOptions(), samplingRequest())

		expect(mocks.streamSimple.mock.calls[0]?.[2]).not.toHaveProperty("reasoning")
	})

	it("falls back to complete without reasoning when streamSimple is unavailable", async () => {
		const result = await handleSamplingRequest(
			createOptions({
				modelRegistry: { getAvailable: () => [model], complete: mocks.complete },
				getThinkingLevel: () => "high",
			}),
			samplingRequest({ locale: "fr" }),
		)

		expect(result.content).toEqual({ type: "text", text: "Bonjour" })
		expect(mocks.complete.mock.calls[0]?.[2]).toEqual({ maxTokens: 50, metadata: { locale: "fr" } })
	})
})
