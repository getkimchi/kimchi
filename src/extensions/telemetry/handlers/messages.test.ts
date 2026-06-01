import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../../config.js"
import { SessionContext, _resetSharedAccumulators } from "../session-context.js"
import { handleAgentEnd, handleBeforeAgentStart, handleMessageEnd, handleMessageStart } from "./messages.js"

vi.mock("../../../startup-context.js", () => ({
	getAvailableModels: vi.fn(() => []),
}))

vi.mock("../../../api/me.js", () => ({
	getMe: vi.fn().mockResolvedValue({ id: "test-user", email: "test@example.com" }),
}))

function makeConfig(overrides: Partial<TelemetryConfig> = {}): TelemetryConfig {
	return {
		enabled: true,
		endpoint: "https://test.example.com/logs",
		metricsEndpoint: "https://test.example.com/metrics",
		headers: { Authorization: "Bearer test" },
		apiKey: "",
		...overrides,
	}
}

function makeCtx(source = "cli", mode = "coding"): SessionContext {
	return new SessionContext(makeConfig(), source, mode)
}

describe("handleMessageStart", () => {
	it("sets messageStartTime for assistant messages using responseId", () => {
		const ctx = makeCtx()
		const before = Date.now()
		handleMessageStart(ctx, { message: { role: "assistant", responseId: "resp-123" } })
		const after = Date.now()
		const stored = ctx.messageStartTimes.get("resp-123")
		expect(stored).toBeGreaterThanOrEqual(before)
		expect(stored).toBeLessThanOrEqual(after)
	})

	it("sets messageStartTime using timestamp when responseId is absent", () => {
		const ctx = makeCtx()
		handleMessageStart(ctx, { message: { role: "assistant", timestamp: 1700000000000 } })
		expect(ctx.messageStartTimes.has("1700000000000")).toBe(true)
	})

	it("ignores non-assistant messages", () => {
		const ctx = makeCtx()
		handleMessageStart(ctx, { message: { role: "user", responseId: "resp-456" } })
		expect(ctx.messageStartTimes.size).toBe(0)
	})

	it("updates currentModel from message when available", () => {
		const ctx = makeCtx()
		expect(ctx.currentModel).toBe("unknown")
		handleMessageStart(ctx, { message: { role: "assistant", responseId: "resp-m", model: "claude-3-5-sonnet" } })
		expect(ctx.currentModel).toBe("claude-3-5-sonnet")
	})

	it("does not overwrite currentModel with unknown", () => {
		const ctx = makeCtx()
		ctx.currentModel = "claude-3-5-sonnet"
		handleMessageStart(ctx, { message: { role: "assistant", responseId: "resp-m2" } })
		expect(ctx.currentModel).toBe("claude-3-5-sonnet")
	})
})

describe("handleMessageEnd", () => {
	let originalFetch: typeof globalThis.fetch

	beforeEach(() => {
		originalFetch = globalThis.fetch
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: vi.fn().mockResolvedValue(""),
		} as unknown as Response)
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
		_resetSharedAccumulators()
		vi.restoreAllMocks()
	})

	it("emits api_request with source and mode", async () => {
		const ctx = makeCtx("vscode", "ferment")
		const emitSpy = vi.spyOn(ctx, "emit")

		await handleMessageEnd(ctx, {
			message: {
				role: "assistant",
				responseId: "resp-1",
				model: "claude-3-5-sonnet",
				provider: "anthropic",
				usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.005 } },
			},
		})

		expect(emitSpy).toHaveBeenCalledOnce()
		const [eventName, attrs] = emitSpy.mock.calls[0]
		expect(eventName).toBe("api_request")
		expect(attrs.model).toBe("claude-3-5-sonnet")
		expect(attrs.provider).toBe("anthropic")
		expect(attrs.input_tokens).toBe(100)
		expect(attrs.output_tokens).toBe(50)
		expect(attrs.cost_usd).toBe(0.005)
	})

	it("deduplicates messages by responseId", async () => {
		const ctx = makeCtx()
		const emitSpy = vi.spyOn(ctx, "emit")

		const event = {
			message: {
				role: "assistant",
				responseId: "resp-dup",
				model: "claude-3-5-sonnet",
				provider: "anthropic",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
			},
		}

		await handleMessageEnd(ctx, event)
		await handleMessageEnd(ctx, event)

		expect(emitSpy).toHaveBeenCalledOnce()
	})

	it("accumulates tokens into cumulative state", async () => {
		const ctx = makeCtx()

		await handleMessageEnd(ctx, {
			message: {
				role: "assistant",
				responseId: "resp-a",
				model: "claude-3-5-sonnet",
				provider: "anthropic",
				usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: { total: 0.01 } },
			},
		})
		await handleMessageEnd(ctx, {
			message: {
				role: "assistant",
				responseId: "resp-b",
				model: "claude-3-5-sonnet",
				provider: "anthropic",
				usage: { input: 200, output: 30, cacheRead: 20, cacheWrite: 0, cost: { total: 0.02 } },
			},
		})

		const tokens = ctx.cumulative.tokensByModel["claude-3-5-sonnet"]
		expect(tokens.input).toBe(300)
		expect(tokens.output).toBe(80)
		expect(tokens.cacheRead).toBe(30)
		expect(tokens.cacheWrite).toBe(5)
		expect(ctx.cumulative.costByModel["claude-3-5-sonnet"]).toBeCloseTo(0.03)
	})

	it("resolves provider via kimchi-dev to ai-enabler", async () => {
		const ctx = makeCtx()
		const emitSpy = vi.spyOn(ctx, "emit")

		await handleMessageEnd(ctx, {
			message: {
				role: "assistant",
				responseId: "resp-kd",
				model: "some-model",
				provider: "kimchi-dev",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
			},
		})

		const [, attrs] = emitSpy.mock.calls[0]
		expect(attrs.provider).toBe("ai-enabler")
	})

	it("maps subscription provider IDs to canonical names in telemetry logs", async () => {
		const ctx = makeCtx()
		const emitSpy = vi.spyOn(ctx, "emit")

		await handleMessageEnd(ctx, {
			message: {
				role: "assistant",
				responseId: "resp-sub",
				model: "some-model",
				provider: "openai-codex",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
			},
		})

		const [, attrs] = emitSpy.mock.calls[0]
		expect(attrs.provider).toBe("openai")
	})

	it("updates currentModel for subsequent tool events", async () => {
		const ctx = makeCtx()
		expect(ctx.currentModel).toBe("unknown")

		await handleMessageEnd(ctx, {
			message: {
				role: "assistant",
				responseId: "resp-model",
				model: "claude-3-5-sonnet",
				provider: "anthropic",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
			},
		})

		expect(ctx.currentModel).toBe("claude-3-5-sonnet")
	})

	it("ignores non-assistant messages", async () => {
		const ctx = makeCtx()
		const emitSpy = vi.spyOn(ctx, "emit")

		await handleMessageEnd(ctx, { message: { role: "user" } })

		expect(emitSpy).not.toHaveBeenCalled()
	})
})

describe("handleBeforeAgentStart", () => {
	let originalFetch: typeof globalThis.fetch

	beforeEach(() => {
		originalFetch = globalThis.fetch
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: vi.fn().mockResolvedValue(""),
		} as unknown as Response)
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
		_resetSharedAccumulators()
		vi.restoreAllMocks()
	})

	it("emits kimchi.user_message with message_length and model", () => {
		const ctx = makeCtx()
		ctx.currentModel = "claude-3-5-sonnet"
		const emitSpy = vi.spyOn(ctx, "emit")

		handleBeforeAgentStart(ctx, { prompt: "Hello world!" })

		expect(emitSpy).toHaveBeenCalledOnce()
		const [eventName, attrs] = emitSpy.mock.calls[0]
		expect(eventName).toBe("user_message")
		expect(attrs.message_length).toBe(12)
		expect(attrs.model).toBe("claude-3-5-sonnet")
	})
})

describe("handleAgentEnd", () => {
	let originalFetch: typeof globalThis.fetch

	beforeEach(() => {
		originalFetch = globalThis.fetch
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: vi.fn().mockResolvedValue(""),
		} as unknown as Response)
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
		_resetSharedAccumulators()
		vi.restoreAllMocks()
	})

	it("emits kimchi.error when last message is a toolResult with isError=true", () => {
		const ctx = makeCtx()
		ctx.currentModel = "claude-3-5-sonnet"
		const emitSpy = vi.spyOn(ctx, "emit")

		handleAgentEnd(ctx, {
			messages: [
				{ role: "assistant", content: [{ text: "some output" }] },
				{ role: "toolResult", isError: true, content: [{ text: "Error: something went wrong" }] },
			],
		})

		expect(emitSpy).toHaveBeenCalledOnce()
		const [eventName, attrs] = emitSpy.mock.calls[0]
		expect(eventName).toBe("error")
		expect(attrs.error_type).toBe("agent_error")
		expect(attrs.error_message).toContain("Error: something went wrong")
		expect(attrs.model).toBe("claude-3-5-sonnet")
	})

	it("does not emit when last toolResult has isError=false", () => {
		const ctx = makeCtx()
		const emitSpy = vi.spyOn(ctx, "emit")

		handleAgentEnd(ctx, {
			messages: [{ role: "toolResult", isError: false, content: [{ text: "Task completed successfully" }] }],
		})

		expect(emitSpy).not.toHaveBeenCalled()
	})

	it("does not false-positive on text containing the word error when isError=false", () => {
		const ctx = makeCtx()
		const emitSpy = vi.spyOn(ctx, "emit")

		handleAgentEnd(ctx, {
			messages: [{ role: "toolResult", isError: false, content: [{ text: "No errors found" }] }],
		})

		expect(emitSpy).not.toHaveBeenCalled()
	})

	it("does not emit when messages array is empty", () => {
		const ctx = makeCtx()
		const emitSpy = vi.spyOn(ctx, "emit")

		handleAgentEnd(ctx, { messages: [] })

		expect(emitSpy).not.toHaveBeenCalled()
	})

	it("does not emit when messages is undefined", () => {
		const ctx = makeCtx()
		const emitSpy = vi.spyOn(ctx, "emit")

		handleAgentEnd(ctx, {})

		expect(emitSpy).not.toHaveBeenCalled()
	})

	it("does not emit when last message is not toolResult", () => {
		const ctx = makeCtx()
		const emitSpy = vi.spyOn(ctx, "emit")

		handleAgentEnd(ctx, {
			messages: [{ role: "assistant", content: [{ text: "Error in my thoughts" }] }],
		})

		expect(emitSpy).not.toHaveBeenCalled()
	})
})
