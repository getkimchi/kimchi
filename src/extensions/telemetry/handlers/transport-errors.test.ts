// @ts-nocheck
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { createContext } from "../../__mocks__/context.js"
import type { TelemetryContext } from "../session-context.js"
import { handleTransportError } from "./transport-errors.js"

function mockSessionCtx(): Pick<TelemetryContext, "emit"> {
	return {
		emit: vi.fn(),
	}
}

function mockPiCtx(overrides?: { sessionId?: string; model?: string }): ExtensionContext {
	return createContext({
		sessionManager: { getSessionId: () => overrides?.sessionId ?? "test-session" },
		model: { id: overrides?.model ?? "unknown" },
	})
}

describe("handleTransportError", () => {
	it("does not emit when role is not assistant", () => {
		const sessionCtx = mockSessionCtx()
		handleTransportError(sessionCtx as TelemetryContext, mockPiCtx(), {
			message: { role: "user", stopReason: "error", errorMessage: "socket connection was closed unexpectedly" },
		})
		expect(sessionCtx.emit).not.toHaveBeenCalled()
	})

	it("does not emit when stopReason is not error", () => {
		const sessionCtx = mockSessionCtx()
		handleTransportError(sessionCtx as TelemetryContext, mockPiCtx(), {
			message: { role: "assistant", stopReason: "stop", errorMessage: "socket connection was closed unexpectedly" },
		})
		expect(sessionCtx.emit).not.toHaveBeenCalled()
	})

	it("does not emit when stopReason is aborted (user cancelled)", () => {
		const sessionCtx = mockSessionCtx()
		handleTransportError(sessionCtx as TelemetryContext, mockPiCtx(), {
			message: { role: "assistant", stopReason: "aborted", errorMessage: "socket connection was closed unexpectedly" },
		})
		expect(sessionCtx.emit).not.toHaveBeenCalled()
	})

	it("does not emit when errorMessage is not a transport error", () => {
		const sessionCtx = mockSessionCtx()
		handleTransportError(sessionCtx as TelemetryContext, mockPiCtx(), {
			message: { role: "assistant", stopReason: "error", errorMessage: "something went wrong" },
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
			},
		})
		expect(sessionCtx.emit).toHaveBeenCalledTimes(1)
		expect(sessionCtx.emit).toHaveBeenCalledWith(
			"error",
			{
				error_type: "transport_error",
				error_message: errorMessage,
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
			},
		})
		expect(sessionCtx.emit).toHaveBeenCalledWith(
			"error",
			expect.objectContaining({ error_type: "transport_error", error_message: expect.any(String) }),
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
			},
		})
		expect(sessionCtx.emit).toHaveBeenCalledWith(
			"error",
			expect.objectContaining({ error_type: "transport_error", error_message: "Connection reset by peer" }),
			expect.anything(),
		)
	})

	it("emits error for socket closed", () => {
		const sessionCtx = mockSessionCtx()
		handleTransportError(sessionCtx as TelemetryContext, mockPiCtx(), {
			message: { role: "assistant", stopReason: "error", errorMessage: "socket closed" },
		})
		expect(sessionCtx.emit).toHaveBeenCalledWith(
			"error",
			expect.objectContaining({ error_type: "transport_error", error_message: "socket closed" }),
			expect.anything(),
		)
	})

	it("emits error for connection closed", () => {
		const sessionCtx = mockSessionCtx()
		handleTransportError(sessionCtx as TelemetryContext, mockPiCtx(), {
			message: { role: "assistant", stopReason: "error", errorMessage: "connection closed" },
		})
		expect(sessionCtx.emit).toHaveBeenCalledWith(
			"error",
			expect.objectContaining({ error_type: "transport_error", error_message: "connection closed" }),
			expect.anything(),
		)
	})

	it("emits error for econnreset", () => {
		const sessionCtx = mockSessionCtx()
		handleTransportError(sessionCtx as TelemetryContext, mockPiCtx(), {
			message: { role: "assistant", stopReason: "error", errorMessage: "read ECONNRESET" },
		})
		expect(sessionCtx.emit).toHaveBeenCalledWith(
			"error",
			expect.objectContaining({ error_type: "transport_error", error_message: "read ECONNRESET" }),
			expect.anything(),
		)
	})

	it("emits error for econnrefused", () => {
		const sessionCtx = mockSessionCtx()
		handleTransportError(sessionCtx as TelemetryContext, mockPiCtx(), {
			message: { role: "assistant", stopReason: "error", errorMessage: "connect ECONNREFUSED 127.0.0.1:443" },
		})
		expect(sessionCtx.emit).toHaveBeenCalledWith(
			"error",
			expect.objectContaining({
				error_type: "transport_error",
				error_message: "connect ECONNREFUSED 127.0.0.1:443",
			}),
			expect.anything(),
		)
	})

	it("emits error for broken pipe", () => {
		const sessionCtx = mockSessionCtx()
		handleTransportError(sessionCtx as TelemetryContext, mockPiCtx(), {
			message: { role: "assistant", stopReason: "error", errorMessage: "Broken pipe" },
		})
		expect(sessionCtx.emit).toHaveBeenCalledWith(
			"error",
			expect.objectContaining({ error_type: "transport_error", error_message: "Broken pipe" }),
			expect.anything(),
		)
	})

	it("handles missing optional fields gracefully", () => {
		const sessionCtx = mockSessionCtx()
		const piCtx = mockPiCtx({ sessionId: "sess-2" })
		handleTransportError(sessionCtx as TelemetryContext, piCtx, {
			message: { role: "assistant", stopReason: "error", errorMessage: "socket connection was closed unexpectedly" },
		})
		expect(sessionCtx.emit).toHaveBeenCalledWith(
			"error",
			{
				error_type: "transport_error",
				error_message: "socket connection was closed unexpectedly",
			},
			piCtx,
		)
	})

	it("truncates error_message to 300 chars", () => {
		const sessionCtx = mockSessionCtx()
		const longMessage = `socket connection was closed unexpectedly ${"x".repeat(400)}`
		handleTransportError(sessionCtx as TelemetryContext, mockPiCtx(), {
			message: { role: "assistant", stopReason: "error", errorMessage: longMessage },
		})
		const emitted = (sessionCtx.emit as ReturnType<typeof vi.fn>).mock.calls[0][1] as { error_message: string }
		expect(emitted.error_message.length).toBe(300)
		expect(emitted.error_message.endsWith("xxx")).toBe(true)
	})
})
