import { describe, expect, it, vi } from "vitest"
import Terminal from "terminal.js"
import { TerminalComponent } from "./terminal-component.js"

function mockSession() {
  return { write: vi.fn(), resize: vi.fn(), close: vi.fn() }
}

function mockTui() {
  return { terminal: { rows: 24 }, requestRender: vi.fn() }
}

describe("TerminalComponent handleInput", () => {
  it("passes plain text through as UTF-8", () => {
    const session = mockSession()
    const component = new TerminalComponent(mockTui() as any, session as any)
    component.handleInput("hello")
    expect(session.write).toHaveBeenCalledWith(Buffer.from("hello", "utf-8"))
  })

  it("converts kitty ctrl+d to raw \\x04", () => {
    const session = mockSession()
    const component = new TerminalComponent(mockTui() as any, session as any)
    component.handleInput("\x1b[100;5u")
    expect(session.write).toHaveBeenCalledWith(Buffer.from("\x04"))
  })

  it("converts kitty plain 'd' to raw 'd'", () => {
    const session = mockSession()
    const component = new TerminalComponent(mockTui() as any, session as any)
    component.handleInput("\x1b[100u")
    expect(session.write).toHaveBeenCalledWith(Buffer.from("d"))
  })

  it("ignores kitty key release events", () => {
    const session = mockSession()
    const component = new TerminalComponent(mockTui() as any, session as any)
    component.handleInput("\x1b[100;1:3u")
    expect(session.write).toHaveBeenCalledWith(Buffer.alloc(0))
  })

  it("passes legacy escape sequences through", () => {
    const session = mockSession()
    const component = new TerminalComponent(mockTui() as any, session as any)
    component.handleInput("\x1b[A")
    expect(session.write).toHaveBeenCalledWith(Buffer.from("\x1b[A", "utf-8"))
  })

  it("converts kitty shift+tab to \\x1b[Z", () => {
    const session = mockSession()
    const component = new TerminalComponent(mockTui() as any, session as any)
    component.handleInput("\x1b[9;2u")
    expect(session.write).toHaveBeenCalledWith(Buffer.from("\x1b[Z"))
  })

  it("converts kitty alt+enter to \\x1b\\r", () => {
    const session = mockSession()
    const component = new TerminalComponent(mockTui() as any, session as any)
    component.handleInput("\x1b[13;3u")
    expect(session.write).toHaveBeenCalledWith(Buffer.from("\x1b\r"))
  })
})

describe("terminal.js integration", () => {
	it("processes ANSI escape sequences", () => {
		const term = new Terminal({ columns: 10, rows: 3 })
		term.write("\x1b[31mred\x1b[0m\n")
		expect(term.state.getBufferRowCount()).toBeGreaterThanOrEqual(1)
		expect(term.state.getLine(0).str).toContain("red")
	})

	it("tracks cursor position", () => {
		const term = new Terminal({ columns: 10, rows: 3 })
		term.write("hi")
		expect(term.state.cursor.x).toBe(2)
		expect(term.state.cursor.y).toBe(0)
	})

	it("resizes correctly", () => {
		const term = new Terminal({ columns: 10, rows: 3 })
		term.state.resize({ columns: 20, rows: 5 })
		expect(term.state.columns).toBe(20)
		expect(term.state.rows).toBe(5)
	})
})
