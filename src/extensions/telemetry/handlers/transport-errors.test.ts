import { describe, expect, it, vi } from "vitest"
import type { SessionContext } from "../session-context.js"
import { handleTransportError } from "./transport-errors.js"

function mockCtx(): Pick<SessionContext, "emit"> {
	return {
		emit: vi.fn(),
	}
}

describe("handleTransportError", () => {
	it("does not emit when role is not assistant", () => {
		const ctx = mockCtx()
		handleTransportError(ctx as SessionContext, {
			message: { role: "user", stopReason: "error", errorMessage: "socket connection was closed unexpectedly" },
		})
		expect(ctx.emit).not.toHaveBeenCalled()
	})

	it("does not emit when stopReason is not error", () => {
		const ctx = mockCtx()
		handleTransportError(ctx as SessionContext, {
			message: { role: "assistant", stopReason: "stop", errorMessage: "socket connection was closed unexpectedly" },
		})
		expect(ctx.emit).not.toHaveBeenCalled()
	})

	it("does not emit when stopReason is aborted (user cancelled)", () => {
		const ctx = mockCtx()
		handleTransportError(ctx as SessionContext, {
			message: { role: "assistant", stopReason: "aborted", errorMessage: "socket connection was closed unexpectedly" },
		})
		expect(ctx.emit).not.toHaveBeenCalled()
	})

	it("does not emit when errorMessage is not a transport error", () => {
		const ctx = mockCtx()
		handleTransportError(ctx as SessionContext, {
			message: { role: "assistant", stopReason: "error", errorMessage: "something went wrong" },
		})
		expect(ctx.emit).not.toHaveBeenCalled()
	})

	it("emits error with error_type transport_error for socket connection was closed unexpectedly", () => {
		const ctx = mockCtx()
		handleTransportError(ctx as SessionContext, {
			message: {
				role: "assistant",
				model: "kimi-k2.6",
				provider: "kimchi-dev",
				api: "openai-completions",
				stopReason: "error",
				errorMessage:
					"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
			},
		})
		expect(ctx.emit).toHaveBeenCalledTimes(1)
		expect(ctx.emit).toHaveBeenCalledWith("error", {
			model: "kimi-k2.6",
			error_type: "transport_error",
			error_message:
				"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
		})
	})

	it("emits error case-insensitively", () => {
		const ctx = mockCtx()
		handleTransportError(ctx as SessionContext, {
			message: {
				role: "assistant",
				model: "claude-sonnet-4-20250514",
				stopReason: "error",
				errorMessage: "THE SOCKET CONNECTION WAS CLOSED UNEXPECTEDLY",
			},
		})
		expect(ctx.emit).toHaveBeenCalledWith(
			"error",
			expect.objectContaining({ error_type: "transport_error", error_message: expect.any(String) }),
		)
	})

	it("emits error for connection reset", () => {
		const ctx = mockCtx()
		handleTransportError(ctx as SessionContext, {
			message: {
				role: "assistant",
				model: "claude-sonnet-4-20250514",
				stopReason: "error",
				errorMessage: "Connection reset by peer",
			},
		})
		expect(ctx.emit).toHaveBeenCalledWith(
			"error",
			expect.objectContaining({ error_type: "transport_error", error_message: "Connection reset by peer" }),
		)
	})

	it("emits error for socket closed", () => {
		const ctx = mockCtx()
		handleTransportError(ctx as SessionContext, {
			message: { role: "assistant", stopReason: "error", errorMessage: "socket closed" },
		})
		expect(ctx.emit).toHaveBeenCalledWith(
			"error",
			expect.objectContaining({ error_type: "transport_error", error_message: "socket closed" }),
		)
	})

	it("emits error for connection closed", () => {
		const ctx = mockCtx()
		handleTransportError(ctx as SessionContext, {
			message: { role: "assistant", stopReason: "error", errorMessage: "connection closed" },
		})
		expect(ctx.emit).toHaveBeenCalledWith(
			"error",
			expect.objectContaining({ error_type: "transport_error", error_message: "connection closed" }),
		)
	})

	it("emits error for econnreset", () => {
		const ctx = mockCtx()
		handleTransportError(ctx as SessionContext, {
			message: { role: "assistant", stopReason: "error", errorMessage: "read ECONNRESET" },
		})
		expect(ctx.emit).toHaveBeenCalledWith(
			"error",
			expect.objectContaining({ error_type: "transport_error", error_message: "read ECONNRESET" }),
		)
	})

	it("emits error for econnrefused", () => {
		const ctx = mockCtx()
		handleTransportError(ctx as SessionContext, {
			message: { role: "assistant", stopReason: "error", errorMessage: "connect ECONNREFUSED 127.0.0.1:443" },
		})
		expect(ctx.emit).toHaveBeenCalledWith(
			"error",
			expect.objectContaining({
				error_type: "transport_error",
				error_message: "connect ECONNREFUSED 127.0.0.1:443",
			}),
		)
	})

	it("emits error for broken pipe", () => {
		const ctx = mockCtx()
		handleTransportError(ctx as SessionContext, {
			message: { role: "assistant", stopReason: "error", errorMessage: "Broken pipe" },
		})
		expect(ctx.emit).toHaveBeenCalledWith(
			"error",
			expect.objectContaining({ error_type: "transport_error", error_message: "Broken pipe" }),
		)
	})

	it("handles missing optional fields gracefully", () => {
		const ctx = mockCtx()
		handleTransportError(ctx as SessionContext, {
			message: { role: "assistant", stopReason: "error", errorMessage: "socket connection was closed unexpectedly" },
		})
		expect(ctx.emit).toHaveBeenCalledWith("error", {
			model: "unknown",
			error_type: "transport_error",
			error_message: "socket connection was closed unexpectedly",
		})
	})

	it("truncates error_message to 300 chars", () => {
		const ctx = mockCtx()
		const longMessage = `socket connection was closed unexpectedly ${"x".repeat(400)}`
		handleTransportError(ctx as SessionContext, {
			message: { role: "assistant", stopReason: "error", errorMessage: longMessage },
		})
		const emitted = (ctx.emit as ReturnType<typeof vi.fn>).mock.calls[0][1] as { error_message: string }
		expect(emitted.error_message.length).toBe(300)
		expect(emitted.error_message.endsWith("xxx")).toBe(true)
	})
})
