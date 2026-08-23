import type { Message } from "@earendil-works/pi-ai"
import type { AgentEndEvent, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../../config.js"
import { createContext } from "../../__mocks__/context.js"
import { _resetSharedAccumulators, type TelemetryAttributes, TelemetryContext } from "../session-context.js"
import { handleAgentEnd, handleBeforeAgentStart, handleMessageEnd, handleMessageStart } from "./messages.js"

const BASE_TS = new Date("2026-06-02T10:00:00.000Z").getTime()

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

function makeCtx(modelId?: string): { ctx: TelemetryContext; piCtx: ExtensionContext } {
	const piCtx = createContext(modelId ? { model: { id: modelId } } : undefined)
	const ctx = new TelemetryContext(makeConfig())
	return { ctx, piCtx }
}

describe("handleMessageStart", () => {
	it("sets messageStartTime for assistant messages using timestamp", () => {
		const { ctx, piCtx } = makeCtx()
		const before = Date.now()
		handleMessageStart(ctx, piCtx, { message: { role: "assistant", timestamp: BASE_TS } as Message })
		const after = Date.now()
		const stored = ctx.messageStartTimes.get(String(BASE_TS))
		expect(stored).toBeGreaterThanOrEqual(before)
		expect(stored).toBeLessThanOrEqual(after)
	})

	it("sets messageStartTime using timestamp", () => {
		const { ctx, piCtx } = makeCtx()
		handleMessageStart(ctx, piCtx, { message: { role: "assistant", timestamp: BASE_TS } as Message })
		// Only timestamp is used for timing tracking; responseId is ignored here.
		expect(ctx.messageStartTimes.has(String(BASE_TS))).toBe(true)
	})

	it("ignores non-assistant messages", () => {
		const { ctx, piCtx } = makeCtx()
		handleMessageStart(ctx, piCtx, { message: { role: "user", timestamp: BASE_TS + 1 } as Message })
		expect(ctx.messageStartTimes.size).toBe(0)
	})

	it("records start time for assistant messages", () => {
		const { ctx, piCtx } = makeCtx()
		handleMessageStart(ctx, piCtx, { message: { role: "assistant", timestamp: BASE_TS + 2 } as Message })
		expect(ctx.messageStartTimes.has(String(BASE_TS + 2))).toBe(true)
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

	it("emits api_request with source and session_type", async () => {
		const { ctx, piCtx } = makeCtx()
		const emitSpy = vi.spyOn(ctx, "emit")

		await handleMessageEnd(ctx, piCtx, {
			message: {
				role: "assistant",
				responseId: "resp-1",
				model: "claude-3-5-sonnet",
				provider: "anthropic",
				usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.005 } },
			} as Message,
		})

		expect(emitSpy).toHaveBeenCalledOnce()
		// biome-ignore lint/style/noNonNullAssertion: -
		const [eventName, attrs] = emitSpy.mock.calls[0]! as [string, TelemetryAttributes]
		expect(eventName).toBe("api_request")
		expect(attrs.provider).toBe("anthropic")
		expect(attrs.input_tokens).toBe(100)
		expect(attrs.output_tokens).toBe(50)
		expect(attrs.cost_usd).toBe(0.005)
	})

	it("deduplicates messages by responseId", async () => {
		const { ctx, piCtx } = makeCtx()
		const emitSpy = vi.spyOn(ctx, "emit")

		const event = {
			message: {
				role: "assistant",
				responseId: "resp-dup",
				model: "claude-3-5-sonnet",
				provider: "anthropic",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
			} as Message,
		}

		await handleMessageEnd(ctx, piCtx, event)
		await handleMessageEnd(ctx, piCtx, event)

		expect(emitSpy).toHaveBeenCalledOnce()
	})

	it("accumulates tokens into cumulative state", async () => {
		const { ctx, piCtx } = makeCtx()

		await handleMessageEnd(ctx, piCtx, {
			message: {
				role: "assistant",
				responseId: "resp-a",
				model: "claude-3-5-sonnet",
				provider: "anthropic",
				usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: { total: 0.01 } },
			} as Message,
		})
		await handleMessageEnd(ctx, piCtx, {
			message: {
				role: "assistant",
				responseId: "resp-b",
				model: "claude-3-5-sonnet",
				provider: "anthropic",
				usage: { input: 200, output: 30, cacheRead: 20, cacheWrite: 0, cost: { total: 0.02 } },
			} as Message,
		})

		const tokens = ctx.cumulative.tokensByModel["claude-3-5-sonnet"]
		expect(tokens.input).toBe(300)
		expect(tokens.output).toBe(80)
		expect(tokens.cacheRead).toBe(30)
		expect(tokens.cacheWrite).toBe(5)
		expect(ctx.cumulative.costByModel["claude-3-5-sonnet"]).toBeCloseTo(0.03)
	})

	it("resolves provider via kimchi-dev to ai-enabler", async () => {
		const { ctx, piCtx } = makeCtx()
		const emitSpy = vi.spyOn(ctx, "emit")

		await handleMessageEnd(ctx, piCtx, {
			message: {
				role: "assistant",
				responseId: "resp-kd",
				model: "some-model",
				provider: "kimchi-dev",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
			} as Message,
		})

		// biome-ignore lint/style/noNonNullAssertion: -
		const [, attrs] = emitSpy.mock.calls[0]! as [string, TelemetryAttributes]
		expect(attrs.provider).toBe("ai-enabler")
	})

	it("maps subscription provider IDs to canonical names in telemetry logs", async () => {
		const { ctx, piCtx } = makeCtx()
		const emitSpy = vi.spyOn(ctx, "emit")

		await handleMessageEnd(ctx, piCtx, {
			message: {
				role: "assistant",
				responseId: "resp-sub",
				model: "some-model",
				provider: "openai-codex",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
			} as Message,
		})

		// biome-ignore lint/style/noNonNullAssertion: -
		const [, attrs] = emitSpy.mock.calls[0]! as [string, TelemetryAttributes]
		expect(attrs.provider).toBe("openai")
	})

	it("updates currentModel for subsequent tool events", async () => {
		const { ctx, piCtx } = makeCtx()
		expect(ctx.currentModel).toBe("unknown")

		await handleMessageEnd(ctx, piCtx, {
			message: {
				role: "assistant",
				responseId: "resp-model",
				model: "claude-3-5-sonnet",
				provider: "anthropic",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
			} as Message,
		})

		expect(ctx.currentModel).toBe("claude-3-5-sonnet")
	})

	it("computes correct duration using matched timestamp", async () => {
		const { ctx, piCtx } = makeCtx()
		// Let sessionStartMs age so we can distinguish fallback from correct lookup
		await new Promise((r) => setTimeout(r, 50))
		handleMessageStart(ctx, piCtx, { message: { role: "assistant", timestamp: BASE_TS + 1 } as Message })

		const emitSpy = vi.spyOn(ctx, "emit")
		await handleMessageEnd(ctx, piCtx, {
			message: {
				role: "assistant",
				responseId: "resp-dur",
				timestamp: BASE_TS + 1,
				model: "claude-3-5-sonnet",
				provider: "anthropic",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
			} as Message,
		})

		// biome-ignore lint/style/noNonNullAssertion: -
		const [, attrs] = emitSpy.mock.calls[0]! as [string, TelemetryAttributes]
		// Should be near-zero (messageStart → messageEnd), not ~50ms (sessionStart fallback)
		expect(attrs.duration_ms).toBeLessThan(20)
	})

	it("computes correct duration when message_start lacks responseId", async () => {
		const { ctx, piCtx } = makeCtx()
		// Let sessionStartMs age
		await new Promise((r) => setTimeout(r, 50))

		// message_start fires WITHOUT responseId (common for streaming start)
		handleMessageStart(ctx, piCtx, { message: { role: "assistant", timestamp: BASE_TS } as Message })

		// message_end fires WITH responseId (assigned by provider after response completes)
		const emitSpy = vi.spyOn(ctx, "emit")
		await handleMessageEnd(ctx, piCtx, {
			message: {
				role: "assistant",
				responseId: "resp-after",
				timestamp: BASE_TS,
				model: "claude-3-5-sonnet",
				provider: "anthropic",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
			} as Message,
		})

		// biome-ignore lint/style/noNonNullAssertion: -
		const [, attrs] = emitSpy.mock.calls[0]! as [string, TelemetryAttributes]
		// Should be near-zero (start → end), not ~50ms (sessionStart fallback)
		expect(attrs.duration_ms).toBeLessThan(20)
	})

	it("ignores non-assistant messages", async () => {
		const { ctx, piCtx } = makeCtx()
		const emitSpy = vi.spyOn(ctx, "emit")

		await handleMessageEnd(ctx, piCtx, { message: { role: "user" } as Message })

		expect(emitSpy).not.toHaveBeenCalled()
	})

	it("emits transport_error when stopReason is error and message matches a transport pattern", async () => {
		const { ctx, piCtx } = makeCtx()
		const emitSpy = vi.spyOn(ctx, "emit")

		await handleMessageEnd(ctx, piCtx, {
			message: {
				role: "assistant",
				model: "kimi-k2.6",
				provider: "kimchi-dev",
				stopReason: "error",
				errorMessage:
					"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
				timestamp: BASE_TS,
				responseId: "chatcmpl-transport-test",
			} as Message,
		})

		expect(emitSpy).toHaveBeenCalledWith(
			"error",
			expect.objectContaining({
				error_type: "transport_error",
				error_message: expect.stringContaining("socket connection was closed unexpectedly"),
			}),
			expect.anything(),
		)
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
		const { ctx, piCtx } = makeCtx("claude-3-5-sonnet")
		const emitSpy = vi.spyOn(ctx, "emit")

		handleBeforeAgentStart(ctx, piCtx, { prompt: "Hello world!" })

		expect(emitSpy).toHaveBeenCalledOnce()
		// biome-ignore lint/style/noNonNullAssertion: -
		const [eventName, attrs] = emitSpy.mock.calls[0]! as [string, TelemetryAttributes]
		expect(eventName).toBe("user_message")
		expect(attrs.message_length).toBe(12)
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
		const { ctx, piCtx } = makeCtx("claude-3-5-sonnet")
		const emitSpy = vi.spyOn(ctx, "emit")

		handleAgentEnd(ctx, piCtx, {
			messages: [
				{ role: "assistant", content: [{ text: "some output" }] },
				{ role: "toolResult", isError: true, content: [{ text: "Error: something went wrong" }] },
			],
		} as AgentEndEvent)

		expect(emitSpy).toHaveBeenCalledOnce()
		// biome-ignore lint/style/noNonNullAssertion: -
		const [eventName, attrs] = emitSpy.mock.calls[0]! as [string, TelemetryAttributes]
		expect(eventName).toBe("error")
		expect(attrs.error_type).toBe("agent_error")
		expect(attrs.error_message).toContain("Error: something went wrong")
	})

	it("does not emit when last toolResult has isError=false", () => {
		const { ctx, piCtx } = makeCtx()
		const emitSpy = vi.spyOn(ctx, "emit")

		handleAgentEnd(ctx, piCtx, {
			messages: [{ role: "toolResult", isError: false, content: [{ text: "Task completed successfully" }] }],
		} as AgentEndEvent)

		expect(emitSpy).not.toHaveBeenCalled()
	})

	it("does not false-positive on text containing the word error when isError=false", () => {
		const { ctx, piCtx } = makeCtx()
		const emitSpy = vi.spyOn(ctx, "emit")

		handleAgentEnd(ctx, piCtx, {
			messages: [{ role: "toolResult", isError: false, content: [{ text: "No errors found" }] }],
		} as AgentEndEvent)

		expect(emitSpy).not.toHaveBeenCalled()
	})

	it("does not emit when messages array is empty", () => {
		const { ctx, piCtx } = makeCtx()
		const emitSpy = vi.spyOn(ctx, "emit")

		handleAgentEnd(ctx, piCtx, { messages: [] } as unknown as AgentEndEvent)

		expect(emitSpy).not.toHaveBeenCalled()
	})

	it("does not emit when messages is undefined", () => {
		const { ctx, piCtx } = makeCtx()
		const emitSpy = vi.spyOn(ctx, "emit")

		handleAgentEnd(ctx, piCtx, {} as unknown as AgentEndEvent)

		expect(emitSpy).not.toHaveBeenCalled()
	})

	it("does not emit when last message is not toolResult", () => {
		const { ctx, piCtx } = makeCtx()
		const emitSpy = vi.spyOn(ctx, "emit")

		handleAgentEnd(ctx, piCtx, {
			messages: [{ role: "assistant", content: [{ text: "Error in my thoughts" }] }],
		} as AgentEndEvent)

		expect(emitSpy).not.toHaveBeenCalled()
	})
})
