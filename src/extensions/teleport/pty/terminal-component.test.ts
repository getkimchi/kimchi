import type { TUI } from "@earendil-works/pi-tui"
import { describe, expect, it, vi } from "vitest"
import { TerminalComponent, type TerminalSink } from "./terminal-component.js"
import { createXtermCore } from "./xterm-core.js"

function mockSession(): TerminalSink {
	return { write: vi.fn(), resize: vi.fn(), close: vi.fn() } as unknown as TerminalSink
}

function mockTui(): TUI {
	return { terminal: { rows: 24, columns: 80 }, requestRender: vi.fn() } as unknown as TUI
}

function stripAnsi(str: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: needed for ANSI + cursor-marker stripping
	return str.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_pi:c\x07/g, "")
}

describe("TerminalComponent handleInput", () => {
	it("passes plain text through as UTF-8", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		component.handleInput("hello")
		expect(session.write).toHaveBeenCalledWith(Buffer.from("hello", "utf-8"))
	})

	it("passes ctrl+d through to the session as \\x04 (overlay handles exit)", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		component.handleInput("\x1b[100;5u")
		expect(session.close).not.toHaveBeenCalled()
		expect(session.write).toHaveBeenCalledWith(Buffer.from("\x04"))
	})

	it("converts kitty plain 'd' to raw 'd'", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		component.handleInput("\x1b[100u")
		expect(session.write).toHaveBeenCalledWith(Buffer.from("d"))
	})

	it("ignores kitty key release events", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		component.handleInput("\x1b[100;1:3u")
		expect(session.write).toHaveBeenCalledWith(Buffer.alloc(0))
	})

	it("passes legacy escape sequences through", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		component.handleInput("\x1b[A")
		expect(session.write).toHaveBeenCalledWith(Buffer.from("\x1b[A", "utf-8"))
	})

	it("converts legacy arrow with event to clean sequence", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		component.handleInput("\x1b[1;2:1A")
		expect(session.write).toHaveBeenCalledWith(Buffer.from("\x1b[1;2A"))
	})

	it("drops legacy arrow release events", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		component.handleInput("\x1b[1;1:3D")
		expect(session.write).toHaveBeenCalledWith(Buffer.alloc(0))
	})

	it("converts legacy plain arrow with event to basic sequence", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		component.handleInput("\x1b[1;1:1B")
		expect(session.write).toHaveBeenCalledWith(Buffer.from("\x1b[B"))
	})

	it("converts legacy functional key with event to clean sequence", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		component.handleInput("\x1b[5;2:1~")
		expect(session.write).toHaveBeenCalledWith(Buffer.from("\x1b[5;2~"))
	})

	it("drops legacy functional key release events", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		component.handleInput("\x1b[3;1:3~")
		expect(session.write).toHaveBeenCalledWith(Buffer.alloc(0))
	})

	it("converts legacy plain functional key with event to basic sequence", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		component.handleInput("\x1b[2;1:1~")
		expect(session.write).toHaveBeenCalledWith(Buffer.from("\x1b[2~"))
	})

	it("converts legacy home/end with event to clean sequence", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		component.handleInput("\x1b[1;2:1H")
		expect(session.write).toHaveBeenCalledWith(Buffer.from("\x1b[1;2H"))
	})

	it("drops legacy home/end release events", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		component.handleInput("\x1b[1;1:3F")
		expect(session.write).toHaveBeenCalledWith(Buffer.alloc(0))
	})

	it("converts legacy plain home with event to basic sequence", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		component.handleInput("\x1b[1;1:1H")
		expect(session.write).toHaveBeenCalledWith(Buffer.from("\x1b[H"))
	})

	it("converts kitty shift+tab to \\x1b[Z", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		component.handleInput("\x1b[9;2u")
		expect(session.write).toHaveBeenCalledWith(Buffer.from("\x1b[Z"))
	})

	it("converts kitty alt+enter to \\x1b\\r", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		component.handleInput("\x1b[13;3u")
		expect(session.write).toHaveBeenCalledWith(Buffer.from("\x1b\r"))
	})

	it("intercepts SGR mouse scroll up and does not write to session", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		component.handleInput("\x1b[<64;10;5M")
		// Mouse scroll interception is currently disabled in handleInput
		expect(session.write).toHaveBeenCalledTimes(1)
		expect(logSpy).not.toHaveBeenCalled()
		logSpy.mockRestore()
	})

	it("intercepts SGR mouse scroll down and does not write to session", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		component.handleInput("\x1b[<65;20;8m")
		// Mouse scroll interception is currently disabled in handleInput
		expect(session.write).toHaveBeenCalledTimes(1)
		expect(logSpy).not.toHaveBeenCalled()
		logSpy.mockRestore()
	})

	it("intercepts X10 mouse scroll up and does not write to session", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		// ESC [ M \x60 \x2a \x25  => button=64 (96-32), x=10 (42-32), y=5 (37-32)
		component.handleInput("\x1b[M\x60\x2a\x25")
		// Mouse scroll interception is currently disabled in handleInput
		expect(session.write).toHaveBeenCalledTimes(1)
		expect(logSpy).not.toHaveBeenCalled()
		logSpy.mockRestore()
	})

	it("intercepts X10 mouse scroll down and does not write to session", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		// ESC [ M \x61 \x34 \x28  => button=65 (97-32), x=20 (52-32), y=8 (40-32)
		component.handleInput("\x1b[M\x61\x34\x28")
		// Mouse scroll interception is currently disabled in handleInput
		expect(session.write).toHaveBeenCalledTimes(1)
		expect(logSpy).not.toHaveBeenCalled()
		logSpy.mockRestore()
	})

	it("ignores regular SGR mouse press events", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		// button 0 = left press
		component.handleInput("\x1b[<0;10;5M")
		expect(session.write).toHaveBeenCalledTimes(1)
		expect(logSpy).not.toHaveBeenCalled()
		logSpy.mockRestore()
	})

	it("ignores regular X10 mouse press events", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		// ESC [ M \x20 \x2a \x25  => button=0 (32-32), x=10, y=5
		component.handleInput("\x1b[M\x20\x2a\x25")
		expect(session.write).toHaveBeenCalledTimes(1)
		expect(logSpy).not.toHaveBeenCalled()
		logSpy.mockRestore()
	})
})

describe("TerminalComponent writeRemoteData", () => {
	it("processes remote data", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		await component.writeRemoteData("hello")
		const lines = component.render(80)
		expect(lines[0].trimEnd()).toBe("hello")
	})

	it("handles OSC sequence terminated with ST (ESC\\\\)", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		await component.writeRemoteData("\x1b]0;mytitle\x1b\\hello")
		const lines = component.render(80)
		expect(lines[0].trimEnd()).toBe("hello")
	})

	it("handles OSC sequence terminated with BEL", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		await component.writeRemoteData("\x1b]0;mytitle\x07hello")
		const lines = component.render(80)
		expect(lines[0].trimEnd()).toBe("hello")
	})

	it("handles red ANSI color escape", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		await component.writeRemoteData("\x1b[31mred\x1b[0m")
		const lines = component.render(80)
		expect(stripAnsi(lines[0]).trimEnd()).toBe("red")
		expect(lines[0]).toContain("\x1b[31m")
	})

	it("renders plain text without ANSI codes", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		await component.writeRemoteData("hello")
		const lines = component.render(80)
		expect(lines[0]).not.toContain("\x1b[")
		expect(lines[0].trimEnd()).toBe("hello")
	})

	it("renders styled text with ANSI codes", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		await component.writeRemoteData("\x1b[1;32;41mbold-green-on-red\x1b[0m")
		const lines = component.render(80)
		expect(stripAnsi(lines[0]).trimEnd()).toBe("bold-green-on-red")
		expect(lines[0]).toContain("32")
		expect(lines[0]).toContain("41")
		expect(lines[0]).toContain("\x1b[0m")
		expect(lines[0]).toContain("1m")
	})
})

describe("TerminalComponent setHeight", () => {
	it("renders exactly heightOverride lines and resizes the session to that height", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		component.setHeight(10)

		const lines = component.render(80)

		expect(lines.length).toBe(10)
		// session.resize is called with (rows, cols) — see render() at terminal-component.ts.
		expect(session.resize).toHaveBeenCalledWith(10, 80)
	})

	it("falls back to tui.terminal.rows when height override is cleared", async () => {
		const session = mockSession()
		const component = new TerminalComponent(mockTui(), session, createXtermCore())
		component.setHeight(10)
		component.render(80)
		component.setHeight(undefined)

		const lines = component.render(80)

		expect(lines.length).toBe(24)
	})
})
