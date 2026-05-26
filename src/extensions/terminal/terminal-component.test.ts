import { describe, expect, it, vi } from "vitest"
import { TerminalComponent } from "./terminal-component.js"
import { createGhosttyCore } from "./ghostty-loader.js"

function mockSession(): import("./ssh-session.js").SshSession {
	return { write: vi.fn(), resize: vi.fn(), close: vi.fn() } as unknown as import("./ssh-session.js").SshSession
}

function mockTui(): import("@earendil-works/pi-tui").TUI {
	return { terminal: { rows: 24, columns: 80 }, requestRender: vi.fn() } as unknown as import("@earendil-works/pi-tui").TUI
}

describe("TerminalComponent handleInput", () => {
	it("passes plain text through as UTF-8", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, await createGhosttyCore())
		component.handleInput("hello")
		expect(session.write).toHaveBeenCalledWith(Buffer.from("hello", "utf-8"))
	})

	it("converts kitty ctrl+d to raw \\x04", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, await createGhosttyCore())
		component.handleInput("\x1b[100;5u")
		expect(session.write).toHaveBeenCalledWith(Buffer.from("\x04"))
	})

	it("converts kitty plain 'd' to raw 'd'", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, await createGhosttyCore())
		component.handleInput("\x1b[100u")
		expect(session.write).toHaveBeenCalledWith(Buffer.from("d"))
	})

	it("ignores kitty key release events", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, await createGhosttyCore())
		component.handleInput("\x1b[100;1:3u")
		expect(session.write).toHaveBeenCalledWith(Buffer.alloc(0))
	})

	it("passes legacy escape sequences through", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, await createGhosttyCore())
		component.handleInput("\x1b[A")
		expect(session.write).toHaveBeenCalledWith(Buffer.from("\x1b[A", "utf-8"))
	})

	it("converts kitty shift+tab to \\x1b[Z", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, await createGhosttyCore())
		component.handleInput("\x1b[9;2u")
		expect(session.write).toHaveBeenCalledWith(Buffer.from("\x1b[Z"))
	})

	it("converts kitty alt+enter to \\x1b\\r", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, await createGhosttyCore())
		component.handleInput("\x1b[13;3u")
		expect(session.write).toHaveBeenCalledWith(Buffer.from("\x1b\r"))
	})
})

describe("TerminalComponent writeRemoteData", () => {
	it("processes remote data", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, await createGhosttyCore())
		component.writeRemoteData("hello")
		const lines = component.render(80)
		expect(lines[0].trimEnd()).toBe("hello")
	})

	it("handles OSC sequence terminated with ST (ESC\\\\)", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, await createGhosttyCore())
		component.writeRemoteData("\x1b]0;mytitle\x1b\\hello")
		const lines = component.render(80)
		expect(lines[0].trimEnd()).toBe("hello")
	})

	it("handles OSC sequence terminated with BEL", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, await createGhosttyCore())
		component.writeRemoteData("\x1b]0;mytitle\x07hello")
		const lines = component.render(80)
		expect(lines[0].trimEnd()).toBe("hello")
	})

	it("handles red ANSI color escape", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, await createGhosttyCore())
		component.writeRemoteData("\x1b[31mred\x1b[0m")
		const lines = component.render(80)
		expect(lines[0].trimEnd()).toBe("red")
	})
})
