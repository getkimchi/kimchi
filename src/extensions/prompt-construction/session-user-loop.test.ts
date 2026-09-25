import { describe, expect, it } from "vitest"
import { resolveHasUserLoop } from "./session-user-loop.js"

describe("resolveHasUserLoop", () => {
	const base = { stdinIsTTY: true, stdoutIsTTY: true, acpMode: false }

	it("treats interactive TUI sessions as user-present", () => {
		expect(resolveHasUserLoop(base)).toBe(true)
	})

	it("treats ACP sessions as user-present even without a TTY", () => {
		expect(resolveHasUserLoop({ ...base, acpMode: true, stdinIsTTY: false, stdoutIsTTY: false })).toBe(true)
	})

	it("treats print mode as userless", () => {
		expect(resolveHasUserLoop({ ...base, print: true })).toBe(false)
	})

	it("treats protocol mode as userless", () => {
		expect(resolveHasUserLoop({ ...base, mode: "rpc" })).toBe(false)
	})

	it("treats piped stdin as userless even without a print flag", () => {
		expect(resolveHasUserLoop({ ...base, stdinIsTTY: false })).toBe(false)
	})

	it("treats piped stdout as userless even without a print flag", () => {
		expect(resolveHasUserLoop({ ...base, stdoutIsTTY: false })).toBe(false)
	})

	it("treats a container-like invocation (no TTY, task arg) as userless", () => {
		expect(resolveHasUserLoop({ stdinIsTTY: false, stdoutIsTTY: false, acpMode: false })).toBe(false)
	})
})
