import { describe, expect, it, vi } from "vitest"
import { SessionsPanel, createSessionsPanel } from "./sessions-panel.js"
import type { SessionRow } from "./sessions-table.js"

const NOW = new Date("2026-05-17T12:00:00Z")

function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
	return {
		workspaceId: "w-1",
		workspaceName: "alpha",
		sessionName: "s-1",
		status: "active",
		clientConnected: true,
		lastActivityAt: new Date(NOW.getTime() - 60_000),
		...overrides,
	}
}

const testRows: SessionRow[] = [
	makeRow({ sessionName: "first", workspaceName: "alpha", status: "active", clientConnected: true }),
	makeRow({ sessionName: "second", workspaceName: "beta", status: "idle", clientConnected: false }),
	makeRow({ sessionName: "third", workspaceName: "gamma", status: "disconnected", clientConnected: false }),
]

function makePanel(rows: SessionRow[] = testRows, opts?: { termRows?: number; termCols?: number }) {
	const tui = {
		requestRender: vi.fn(),
		terminal: { rows: opts?.termRows ?? 40, cols: opts?.termCols ?? 120 },
	}
	const done = vi.fn()
	const panel = createSessionsPanel(rows, tui, done)
	return { panel, tui, done }
}

function stripAnsi(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: needed for ANSI stripping
	return s.replace(/\x1b\[[0-9;]*m/g, "")
}

describe("SessionsPanel", () => {
	describe("render", () => {
		it("renders title, header, all rows, and hint line", () => {
			const { panel } = makePanel()
			const text = panel.render(120).map(stripAnsi).join("\n")

			expect(text).toContain("Sessions")
			expect(text).toContain("SESSION")
			expect(text).toContain("WORKSPACE")
			expect(text).toContain("STATUS")
			expect(text).toContain("LAST ACTIVITY")
			expect(text).toContain("CLIENT")
			expect(text).toContain("first")
			expect(text).toContain("second")
			expect(text).toContain("third")
			expect(text).toContain("alpha")
			expect(text).toContain("beta")
			expect(text).toContain("gamma")
			expect(text).toContain("navigate")
			expect(text).toContain("open")
			expect(text).toContain("delete")
			expect(text).toContain("close")
		})

		it("renders box-drawing border around the panel", () => {
			const { panel } = makePanel()
			const lines = panel.render(120).map(stripAnsi)
			expect(lines[0]).toMatch(/^╭─.*Sessions.*─╮$/)
			expect(lines[lines.length - 1]).toMatch(/^╰─+╯$/)
			const contentLines = lines.slice(1, -1)
			for (const line of contentLines) {
				if (line.includes("├") || line.includes("┤")) continue
				expect(line.startsWith("│")).toBe(true)
				expect(line.endsWith("│")).toBe(true)
			}
		})

		it("selects the first row by default with > marker", () => {
			const { panel } = makePanel()
			const lines = panel.render(120).map(stripAnsi)
			const firstLine = lines.find((l) => l.includes("first"))
			expect(firstLine).toMatch(/> .*first/)
			const secondLine = lines.find((l) => l.includes("second"))
			expect(secondLine).not.toMatch(/> .*second/)
		})

		it("renders 'connected' / 'disconnected' in the client column", () => {
			const { panel } = makePanel()
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).toContain("connected")
			expect(text).toContain("disconnected")
		})

		it("renders unreachable rows with '-' for session name", () => {
			const rows = [
				makeRow({ sessionName: "", status: "unreachable", clientConnected: false, lastActivityAt: undefined }),
			]
			const { panel } = makePanel(rows)
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).toContain("unreachable")
			expect(text).toContain("-")
		})

		it("renders an empty placeholder when there are no rows", () => {
			const { panel } = makePanel([])
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).toContain("(no sessions)")
		})
	})

	describe("keyboard navigation", () => {
		it("down arrow moves selection down", () => {
			const { panel, tui } = makePanel()
			panel.handleInput("\x1b[B")
			const lines = panel.render(120).map(stripAnsi)
			expect(lines.find((l) => l.includes("second"))).toMatch(/> .*second/)
			expect(tui.requestRender).toHaveBeenCalled()
		})

		it("j key moves selection down", () => {
			const { panel } = makePanel()
			panel.handleInput("j")
			const lines = panel.render(120).map(stripAnsi)
			expect(lines.find((l) => l.includes("second"))).toMatch(/> .*second/)
		})

		it("k key moves selection up", () => {
			const { panel } = makePanel()
			panel.handleInput("j")
			panel.handleInput("k")
			const lines = panel.render(120).map(stripAnsi)
			expect(lines.find((l) => l.includes("first"))).toMatch(/> .*first/)
		})

		it("clamps at top and bottom", () => {
			const { panel } = makePanel()
			panel.handleInput("k")
			let lines = panel.render(120).map(stripAnsi)
			expect(lines.find((l) => l.includes("first"))).toMatch(/> .*first/)
			panel.handleInput("j")
			panel.handleInput("j")
			panel.handleInput("j")
			lines = panel.render(120).map(stripAnsi)
			expect(lines.find((l) => l.includes("third"))).toMatch(/> .*third/)
		})
	})

	describe("actions", () => {
		it("enter triggers open action with selected row", () => {
			const { panel, done } = makePanel()
			panel.handleInput("\r")
			expect(done).toHaveBeenCalledWith({ action: "open", row: expect.objectContaining({ sessionName: "first" }) })
		})

		it("enter after navigation selects the right row", () => {
			const { panel, done } = makePanel()
			panel.handleInput("j")
			panel.handleInput("\r")
			expect(done).toHaveBeenCalledWith({ action: "open", row: expect.objectContaining({ sessionName: "second" }) })
		})

		it("d triggers delete action with selected row", () => {
			const { panel, done } = makePanel()
			panel.handleInput("d")
			expect(done).toHaveBeenCalledWith({ action: "delete", row: expect.objectContaining({ sessionName: "first" }) })
		})

		it("escape closes without action", () => {
			const { panel, done } = makePanel()
			panel.handleInput("\x1b")
			expect(done).toHaveBeenCalledWith(undefined)
		})

		it("q closes without action", () => {
			const { panel, done } = makePanel()
			panel.handleInput("q")
			expect(done).toHaveBeenCalledWith(undefined)
		})

		it("x closes without action", () => {
			const { panel, done } = makePanel()
			panel.handleInput("x")
			expect(done).toHaveBeenCalledWith(undefined)
		})

		it("enter on an unreachable row is a no-op", () => {
			const rows = [
				makeRow({ sessionName: "", status: "unreachable", clientConnected: false, lastActivityAt: undefined }),
			]
			const { panel, done } = makePanel(rows)
			panel.handleInput("\r")
			expect(done).not.toHaveBeenCalled()
		})

		it("d on an unreachable row is a no-op", () => {
			const rows = [
				makeRow({ sessionName: "", status: "unreachable", clientConnected: false, lastActivityAt: undefined }),
			]
			const { panel, done } = makePanel(rows)
			panel.handleInput("d")
			expect(done).not.toHaveBeenCalled()
		})
	})

	describe("scrolling", () => {
		it("shows only a window when rows exceed terminal height", () => {
			const manyRows = Array.from({ length: 20 }, (_, i) => makeRow({ sessionName: `s-${String(i).padStart(2, "0")}` }))
			const { panel } = makePanel(manyRows, { termRows: 12 })
			const lines = panel.render(120).map(stripAnsi)
			const dataLines = lines.filter((l) => /s-\d{2}/.test(l))
			expect(dataLines.length).toBeLessThan(20)
		})

		it("shows ↓ indicator when items are hidden below", () => {
			const manyRows = Array.from({ length: 20 }, (_, i) => makeRow({ sessionName: `s-${String(i).padStart(2, "0")}` }))
			const { panel } = makePanel(manyRows, { termRows: 12 })
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).toContain("↓")
			expect(text).toContain("more")
		})

		it("shows ↑ indicator when items are hidden above", () => {
			const manyRows = Array.from({ length: 20 }, (_, i) => makeRow({ sessionName: `s-${String(i).padStart(2, "0")}` }))
			const { panel } = makePanel(manyRows, { termRows: 12 })
			for (let i = 0; i < 19; i++) panel.handleInput("j")
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).toContain("↑")
			expect(text).toContain("more")
		})
	})

	describe("stable height", () => {
		it("emits the same line count across navigation when rows exceed viewport", () => {
			const manyRows = Array.from({ length: 25 }, (_, i) => makeRow({ sessionName: `s-${String(i).padStart(2, "0")}` }))
			const { panel } = makePanel(manyRows, { termRows: 20 })
			const baseline = panel.render(120).length
			for (let i = 0; i < 24; i++) {
				panel.handleInput("j")
				expect(panel.render(120).length).toBe(baseline)
			}
			for (let i = 0; i < 24; i++) {
				panel.handleInput("k")
				expect(panel.render(120).length).toBe(baseline)
			}
		})

		it("emits the same line count for empty list and for a populated list", () => {
			const { panel: empty } = makePanel([], { termRows: 20 })
			const { panel: full } = makePanel(testRows, { termRows: 20 })
			expect(empty.render(120).length).toBe(full.render(120).length)
		})
	})

	describe("factory", () => {
		it("createSessionsPanel returns a SessionsPanel instance with lifecycle methods", () => {
			const { panel } = makePanel()
			expect(panel).toBeInstanceOf(SessionsPanel)
			expect(typeof panel.dispose).toBe("function")
			expect(typeof panel.invalidate).toBe("function")
			panel.dispose()
			panel.invalidate()
		})
	})
})
