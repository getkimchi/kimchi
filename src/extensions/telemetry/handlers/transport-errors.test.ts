import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { createContext } from "../../__mocks__/context.js"
import type { TelemetryContext } from "../session-context.js"
import { classifyTransportError, handleTransportError } from "./transport-errors.js"

function mockSessionCtx(): Pick<TelemetryContext, "emit" | "getTraceAttributes"> {
	return {
		emit: vi.fn(),
		getTraceAttributes: () => ({}),
	}
}

function mockPiCtx(overrides?: { sessionId?: string; model?: string }): ExtensionContext {
	return createContext({
		sessionManager: { getSessionId: () => overrides?.sessionId ?? "test-session" },
		model: { id: overrides?.model ?? "unknown" },
	})
}

describe("handleTransportError", () => {
	it("does not emit when stopReason is not error", () => {
		const sessionCtx = mockSessionCtx()
		handleTransportError(sessionCtx as TelemetryContext, mockPiCtx(), {
			message: {
				role: "assistant",
				stopReason: "stop",
				errorMessage: "socket connection was closed unexpectedly",
			} as AssistantMessage,
		})
		expect(sessionCtx.emit).not.toHaveBeenCalled()
	})

	it("does not emit when stopReason is aborted (user cancelled)", () => {
		const sessionCtx = mockSessionCtx()
		handleTransportError(sessionCtx as TelemetryContext, mockPiCtx(), {
			message: {
				role: "assistant",
				stopReason: "aborted",
				errorMessage: "socket connection was closed unexpectedly",
			} as AssistantMessage,
		})
		expect(sessionCtx.emit).not.toHaveBeenCalled()
	})

	it("does not emit when errorMessage is not a transport error", () => {
		const sessionCtx = mockSessionCtx()
		handleTransportError(sessionCtx as TelemetryContext, mockPiCtx(), {
			message: { role: "assistant", stopReason: "error", errorMessage: "something went wrong" } as AssistantMessage,
		})
		expect(sessionCtx.emit).not.toHaveBeenCalled()
	})

	it("emits error with error_type transport_error for socket connection was closed unexpectedly", () => {
		const sessionCtx = mockSessionCtx()
		const piCtx = mockPiCtx({ sessionId: "sess-1", model: "kimi-k2.6" })
		const errorMessage =
			"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()"
		handleTransportError(sessionCtx as TelemetryContext, piCtx, {
			message: {
				role: "assistant",
				model: "kimi-k2.6",
				provider: "kimchi-dev",
				api: "openai-completions",
				stopReason: "error",
				errorMessage,
			} as AssistantMessage,
		})
		expect(sessionCtx.emit).toHaveBeenCalledTimes(1)
		expect(sessionCtx.emit).toHaveBeenCalledWith(
			"error",
			{
				error_type: "transport_error",
				error_message: "Transport: socket closed unexpectedly",
				canonicalization: "v1",
			},
			piCtx,
		)
	})

	it("emits error case-insensitively", () => {
		const sessionCtx = mockSessionCtx()
		handleTransportError(sessionCtx as TelemetryContext, mockPiCtx(), {
			message: {
				role: "assistant",
				model: "claude-sonnet-4-20250514",
				stopReason: "error",
				errorMessage: "THE SOCKET CONNECTION WAS CLOSED UNEXPECTEDLY",
			} as AssistantMessage,
		})
		expect(sessionCtx.emit).toHaveBeenCalledWith(
			"error",
			expect.objectContaining({
				error_type: "transport_error",
				error_message: "Transport: socket closed unexpectedly",
				canonicalization: "v1",
			}),
			expect.anything(),
		)
	})

	it("emits error for connection reset", () => {
		const sessionCtx = mockSessionCtx()
		handleTransportError(sessionCtx as TelemetryContext, mockPiCtx(), {
			message: {
				role: "assistant",
				model: "claude-sonnet-4-20250514",
				stopReason: "error",
				errorMessage: "Connection reset by peer",
			} as AssistantMessage,
		})
		expect(sessionCtx.emit).toHaveBeenCalledWith(
			"error",
			expect.objectContaining({ error_type: "transport_error", error_message: "Transport: connection reset" }),
			expect.anything(),
		)
	})

	it("emits error for socket closed", () => {
		const sessionCtx = mockSessionCtx()
		handleTransportError(sessionCtx as TelemetryContext, mockPiCtx(), {
			message: { role: "assistant", stopReason: "error", errorMessage: "socket closed" } as AssistantMessage,
		})
		expect(sessionCtx.emit).toHaveBeenCalledWith(
			"error",
			expect.objectContaining({ error_type: "transport_error", error_message: "Transport: connection closed" }),
			expect.anything(),
		)
	})

	it("emits error for connection closed", () => {
		const sessionCtx = mockSessionCtx()
		handleTransportError(sessionCtx as TelemetryContext, mockPiCtx(), {
			message: { role: "assistant", stopReason: "error", errorMessage: "connection closed" } as AssistantMessage,
		})
		expect(sessionCtx.emit).toHaveBeenCalledWith(
			"error",
			expect.objectContaining({ error_type: "transport_error", error_message: "Transport: connection closed" }),
			expect.anything(),
		)
	})

	it("emits error for econnreset", () => {
		const sessionCtx = mockSessionCtx()
		handleTransportError(sessionCtx as TelemetryContext, mockPiCtx(), {
			message: { role: "assistant", stopReason: "error", errorMessage: "read ECONNRESET" } as AssistantMessage,
		})
		expect(sessionCtx.emit).toHaveBeenCalledWith(
			"error",
			expect.objectContaining({ error_type: "transport_error", error_message: "Transport: connection reset" }),
			expect.anything(),
		)
	})

	it("emits error for econnrefused", () => {
		const sessionCtx = mockSessionCtx()
		handleTransportError(sessionCtx as TelemetryContext, mockPiCtx(), {
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "connect ECONNREFUSED 127.0.0.1:443",
			} as AssistantMessage,
		})
		expect(sessionCtx.emit).toHaveBeenCalledWith(
			"error",
			expect.objectContaining({
				error_type: "transport_error",
				error_message: "Transport: connection refused",
			}),
			expect.anything(),
		)
	})

	it("emits error for broken pipe", () => {
		const sessionCtx = mockSessionCtx()
		handleTransportError(sessionCtx as TelemetryContext, mockPiCtx(), {
			message: { role: "assistant", stopReason: "error", errorMessage: "Broken pipe" } as AssistantMessage,
		})
		expect(sessionCtx.emit).toHaveBeenCalledWith(
			"error",
			expect.objectContaining({ error_type: "transport_error", error_message: "Transport: broken pipe" }),
			expect.anything(),
		)
	})

	it("handles missing optional fields gracefully", () => {
		const sessionCtx = mockSessionCtx()
		const piCtx = mockPiCtx({ sessionId: "sess-2" })
		handleTransportError(sessionCtx as TelemetryContext, piCtx, {
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "socket connection was closed unexpectedly",
			} as AssistantMessage,
		})
		expect(sessionCtx.emit).toHaveBeenCalledWith(
			"error",
			{
				error_type: "transport_error",
				error_message: "Transport: socket closed unexpectedly",
				canonicalization: "v1",
			},
			piCtx,
		)
	})

	it("canonicalizes a long transport error instead of leaking its raw tail", () => {
		const sessionCtx = mockSessionCtx()
		const longMessage = `socket connection was closed unexpectedly ${"x".repeat(400)}`
		handleTransportError(sessionCtx as TelemetryContext, mockPiCtx(), {
			message: { role: "assistant", stopReason: "error", errorMessage: longMessage } as AssistantMessage,
		})
		const emitted = (sessionCtx.emit as ReturnType<typeof vi.fn>).mock.calls[0][1] as { error_message: string }
		expect(emitted.error_message).toBe("Transport: socket closed unexpectedly")
	})
})

describe("classifyTransportError (direct)", () => {
	it("canonicalizes headers-phase idle timeouts with the same bounded attrs", () => {
		const c = classifyTransportError(
			"Stream idle timeout: socket connection closed — no bytes received from llm.kimchi.dev during headers for 120000ms (read timed out)",
		)
		expect(c.message).toBe("Transport: stream idle timeout")
		expect(c.attrs).toEqual({ upstream_host: "llm.kimchi.dev", idle_timeout_ms: 120000 })
	})

	it("keeps the bounded-length contract on the fail-open branch", () => {
		// Defensive branch: a transport error gated in but matching no family
		// keeps the raw head, truncated to 300 chars.
		const c = classifyTransportError("unknown transport failure " + "x".repeat(400))
		expect(c.message.length).toBe(300)
		expect(c.message.endsWith("xxx")).toBe(true)
		expect(c.attrs).toBeUndefined()
	})
})
