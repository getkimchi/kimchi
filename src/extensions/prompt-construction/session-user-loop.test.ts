import { describe, expect, it } from "vitest"
import { backgroundNotificationsReachUser, resolveHasUserLoop, resolveIsTuiSession } from "./session-user-loop.js"

describe("resolveIsTuiSession", () => {
	const base = { stdinIsTTY: true, stdoutIsTTY: true, acpMode: false }

	it("is true for a plain TTY terminal session", () => {
		expect(resolveIsTuiSession(base)).toBe(true)
	})

	it("is false for ACP sessions even with TTY IO", () => {
		expect(resolveIsTuiSession({ ...base, acpMode: true })).toBe(false)
	})

	it("is false for rpc mode (ACP sessions run as rpc)", () => {
		expect(resolveIsTuiSession({ ...base, mode: "rpc" })).toBe(false)
	})

	it("is false for json protocol mode", () => {
		expect(resolveIsTuiSession({ ...base, mode: "json" })).toBe(false)
	})

	it("is false for print mode even with TTY IO", () => {
		expect(resolveIsTuiSession({ ...base, print: true })).toBe(false)
	})

	it("is false for piped stdin", () => {
		expect(resolveIsTuiSession({ ...base, stdinIsTTY: false })).toBe(false)
	})

	it("is false for piped stdout", () => {
		expect(resolveIsTuiSession({ ...base, stdoutIsTTY: false })).toBe(false)
	})

	it("is false for rpc over piped IO (how frontends spawn it)", () => {
		expect(resolveIsTuiSession({ ...base, mode: "rpc", stdinIsTTY: false, stdoutIsTTY: false })).toBe(false)
	})
})

describe("backgroundNotificationsReachUser", () => {
	it("is true only for the TUI", () => {
		expect(backgroundNotificationsReachUser("tui")).toBe(true)
	})

	it("is false for rpc (ACP sessions run as rpc)", () => {
		expect(backgroundNotificationsReachUser("rpc")).toBe(false)
	})

	it("is false for json mode", () => {
		expect(backgroundNotificationsReachUser("json")).toBe(false)
	})

	it("is false for print mode", () => {
		expect(backgroundNotificationsReachUser("print")).toBe(false)
	})
})

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

	it("treats rpc mode (embedded frontends, human present) as user-present", () => {
		expect(resolveHasUserLoop({ ...base, mode: "rpc" })).toBe(true)
	})

	it("treats rpc mode over piped IO (how frontends spawn it) as user-present", () => {
		expect(resolveHasUserLoop({ ...base, mode: "rpc", stdinIsTTY: false, stdoutIsTTY: false })).toBe(true)
	})

	it("treats json protocol mode as userless", () => {
		expect(resolveHasUserLoop({ ...base, mode: "json" })).toBe(false)
	})

	it("treats piped stdin as userless even without a print flag", () => {
		expect(resolveHasUserLoop({ ...base, stdinIsTTY: false })).toBe(false)
	})

	it("treats piped stdout as userless even without a print flag", () => {
		expect(resolveHasUserLoop({ ...base, stdoutIsTTY: false })).toBe(false)
	})

	it("treats a container-like invocation (no TTYs) as userless", () => {
		expect(resolveHasUserLoop({ stdinIsTTY: false, stdoutIsTTY: false, acpMode: false })).toBe(false)
	})
})
