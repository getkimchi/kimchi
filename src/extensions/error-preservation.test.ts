import { AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { getRawErrorMessage, hasPreservedRawErrorMessage, preserveRawErrorMessage } from "./error-preservation.js"
import interactiveErrorSurfaceExtension from "./interactive-error-surface.js"
import rateLimitNoticeExtension from "./rate-limit-notice.js"

describe("preserveRawErrorMessage", () => {
	it("preserves the original errorMessage before mutation", () => {
		const message = { errorMessage: "InternalServerError: Hosted_vllmException - Cannot connect to host" }
		preserveRawErrorMessage(message)
		message.errorMessage = "Retrying…"
		expect(getRawErrorMessage(message)).toBe("InternalServerError: Hosted_vllmException - Cannot connect to host")
	})

	it("does not overwrite a previously preserved value", () => {
		const message = { errorMessage: "original error" }
		preserveRawErrorMessage(message)
		message.errorMessage = "Retrying…"
		preserveRawErrorMessage(message) // should be a no-op
		message.errorMessage = "Retrying… again"
		expect(getRawErrorMessage(message)).toBe("original error")
	})

	it("is a no-op when errorMessage is absent", () => {
		const message = {}
		preserveRawErrorMessage(message)
		expect(getRawErrorMessage(message)).toBeUndefined()
	})

	it("is a no-op when errorMessage is empty", () => {
		const message = { errorMessage: "" }
		preserveRawErrorMessage(message)
		expect(getRawErrorMessage(message)).toBe("")
	})

	it("stores the value on a symbol (not visible in serialization)", () => {
		const message = { errorMessage: "secret internal error" }
		preserveRawErrorMessage(message)
		message.errorMessage = "Retrying…"
		// JSON.stringify should not include the preserved value — the symbol is
		// enumerable (so spread copies carry it to the retry classifier) but
		// symbol keys never appear in JSON or Object.keys.
		expect(JSON.stringify(message)).not.toContain("secret internal error")
		expect(JSON.stringify(message)).toContain("Retrying…")
		// Object.keys should not include the symbol
		expect(Object.keys(message)).toEqual(["errorMessage"])
	})

	it("falls back to current errorMessage when nothing was preserved", () => {
		const message = { errorMessage: "current error" }
		expect(getRawErrorMessage(message)).toBe("current error")
	})

	it("falls back to current errorMessage after mutation when nothing was preserved", () => {
		const message = { errorMessage: "original" }
		message.errorMessage = "mutated"
		expect(getRawErrorMessage(message)).toBe("mutated")
	})
})

describe("hasPreservedRawErrorMessage", () => {
	it("returns true only when preservation actually happened", () => {
		const message = { errorMessage: "raw error" }
		expect(hasPreservedRawErrorMessage(message)).toBe(false)
		preserveRawErrorMessage(message)
		expect(hasPreservedRawErrorMessage(message)).toBe(true)
	})

	it("returns false when errorMessage was absent (nothing to preserve)", () => {
		expect(hasPreservedRawErrorMessage({})).toBe(false)
	})

	it("returns false when errorMessage was empty (nothing preserved)", () => {
		expect(hasPreservedRawErrorMessage({ errorMessage: "" })).toBe(false)
	})
})

type MessageEndHandler = (event: { type: "message_end"; message: Record<string, unknown> }) => unknown

/** Registers extensions the way cli.ts does and returns their message_end handlers in order. */
function messageEndHandlers(extensions: Array<(pi: ExtensionAPI) => void>): MessageEndHandler[] {
	const handlers: MessageEndHandler[] = []
	const pi = {
		on(event: string, handler: MessageEndHandler) {
			if (event === "message_end") handlers.push(handler)
			return () => {}
		},
	} as unknown as ExtensionAPI
	for (const extension of extensions) extension(pi)
	return handlers
}

// pi applies a replacement returned by a message_end handler in place, onto the
// object that already carries the preserved raw error: AgentSession replaces
// the string keys with Object.assign. A marker that cannot be assigned turns a
// handled provider error into an uncaught TypeError, so this runs the real
// upstream function on the real handler chain rather than a copy of it.
describe("pi replacing the message in place after message_end", () => {
	it("survives the rate-limit notice replacement", () => {
		const handlers = messageEndHandlers([interactiveErrorSurfaceExtension, rateLimitNoticeExtension])
		const raw = `kimi-k2.5 is rate limited until ${new Date(Date.now() + 30 * 60_000).toISOString()}`
		const message: Record<string, unknown> = {
			role: "assistant",
			model: "kimi-k2.5",
			stopReason: "error",
			errorMessage: raw,
		}

		let replacement: Record<string, unknown> | undefined
		for (const handler of handlers) {
			const result = handler({ type: "message_end", message }) as { message?: Record<string, unknown> } | undefined
			if (result?.message) replacement = result.message
		}
		expect(replacement?.errorMessage).toContain("not retrying")

		const session = Object.create(AgentSession.prototype) as unknown as {
			_replaceMessageInPlace(target: Record<string, unknown>, replacement: Record<string, unknown>): void
		}
		expect(() => session._replaceMessageInPlace(message, replacement as Record<string, unknown>)).not.toThrow()

		expect(message.errorMessage).toBe(replacement?.errorMessage)
		expect(getRawErrorMessage(message)).toBe(raw)
	})
})
