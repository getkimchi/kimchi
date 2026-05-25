import { describe, expect, it } from "vitest"
import Terminal from "terminal.js"

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
