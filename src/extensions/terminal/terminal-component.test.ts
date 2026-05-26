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

	it("converts legacy arrow with event to clean sequence", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, await createGhosttyCore())
		component.handleInput("\x1b[1;2:1A")
		expect(session.write).toHaveBeenCalledWith(Buffer.from("\x1b[1;2A"))
	})

	it("drops legacy arrow release events", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, await createGhosttyCore())
		component.handleInput("\x1b[1;1:3D")
		expect(session.write).toHaveBeenCalledWith(Buffer.alloc(0))
	})

	it("converts legacy plain arrow with event to basic sequence", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, await createGhosttyCore())
		component.handleInput("\x1b[1;1:1B")
		expect(session.write).toHaveBeenCalledWith(Buffer.from("\x1b[B"))
	})

	it("converts legacy functional key with event to clean sequence", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, await createGhosttyCore())
		component.handleInput("\x1b[5;2:1~")
		expect(session.write).toHaveBeenCalledWith(Buffer.from("\x1b[5;2~"))
	})

	it("drops legacy functional key release events", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, await createGhosttyCore())
		component.handleInput("\x1b[3;1:3~")
		expect(session.write).toHaveBeenCalledWith(Buffer.alloc(0))
	})

	it("converts legacy plain functional key with event to basic sequence", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, await createGhosttyCore())
		component.handleInput("\x1b[2;1:1~")
		expect(session.write).toHaveBeenCalledWith(Buffer.from("\x1b[2~"))
	})

	it("converts legacy home/end with event to clean sequence", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, await createGhosttyCore())
		component.handleInput("\x1b[1;2:1H")
		expect(session.write).toHaveBeenCalledWith(Buffer.from("\x1b[1;2H"))
	})

	it("drops legacy home/end release events", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, await createGhosttyCore())
		component.handleInput("\x1b[1;1:3F")
		expect(session.write).toHaveBeenCalledWith(Buffer.alloc(0))
	})

	it("converts legacy plain home with event to basic sequence", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, await createGhosttyCore())
		component.handleInput("\x1b[1;1:1H")
		expect(session.write).toHaveBeenCalledWith(Buffer.from("\x1b[H"))
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
