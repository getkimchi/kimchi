import { afterEach, describe, expect, it, vi } from "vitest"
import { createBridgeDiagnostics } from "./diagnostics.js"

afterEach(() => {
	vi.restoreAllMocks()
})

describe("createBridgeDiagnostics", () => {
	it("deduplicates failure and success diagnostics by static reason", () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {})
		const diagnostics = createBridgeDiagnostics()
		diagnostics.note("timeout")
		diagnostics.note("timeout")
		diagnostics.note("io_error")
		expect(log.mock.calls.map(([message]) => String(message)).sort()).toEqual([
			"workspace activity diagnostic: io_error",
			"workspace activity diagnostic: timeout",
		])
	})

	it("does not leak native payload contents into diagnostic text", () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {})
		const diagnostics = createBridgeDiagnostics()
		diagnostics.note("payload_invalid")
		const messages = log.mock.calls.map(([message]) => String(message))
		expect(messages).toEqual(["workspace activity diagnostic: payload_invalid"])
		expect(messages.every((message) => !message.includes("secret-output"))).toBe(true)
	})

	it("logs capacity concerns once without changing command behavior", () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {})
		const diagnostics = createBridgeDiagnostics()
		diagnostics.note("pending_capacity")
		diagnostics.note("pending_capacity")
		expect(log.mock.calls.filter(([message]) => String(message).includes("pending_capacity")).length).toBe(1)
	})
})
