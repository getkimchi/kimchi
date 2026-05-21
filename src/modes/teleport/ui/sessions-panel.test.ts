import { describe, expect, it, vi } from "vitest"
import { SessionsPanel, createSessionsPanel } from "./sessions-panel.js"
import type { SessionRow } from "./sessions-table.js"

const NOW = new Date("2026-05-17T12:00:00Z")

function makeRow(overrides: Partial<SessionRow>): SessionRow {
	return {
		id: "abcd1234efgh",
		host: "x-y-z.remote.kimchi.dev",
		name: "feature-x",
		state: "foreground",
		status: "idle",
		createdAt: new Date(NOW.getTime() - 60_000),
		lastActivityAt: new Date(NOW.getTime() - 60_000),
		...overrides,
	}
}

const testRows: SessionRow[] = [
	makeRow({ id: "sess-1", host: "host-a.example.com", name: "my-session", status: "active" }),
	makeRow({ id: "sess-2", host: "host-b.example.com", name: "other-session", state: "detached", status: "idle" }),
	makeRow({
		id: "sess-3",
		host: undefined,
		name: "third",
		state: "detached (this kimchi)",
		status: "idle",
	}),
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

// Strip ANSI for easier assertions
function stripAnsi(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: needed for ANSI stripping
	return s.replace(/\x1b\[[0-9;]*m/g, "")
}

describe("SessionsPanel", () => {
	describe("render", () => {
		it("renders title, header, all rows, and hint line", () => {
			const { panel } = makePanel()
			const lines = panel.render(120)
			const text = lines.map(stripAnsi).join("\n")

			expect(text).toContain("Sessions")
			expect(text).toContain("ID")
			expect(text).toContain("HOST")
			expect(text).toContain("NAME")
			expect(text).toContain("STATUS")
			expect(text).toContain("LAST ACTIVITY")
			expect(text).toContain("sess-1")
			expect(text).toContain("sess-2")
			expect(text).toContain("sess-3")
			expect(text).toContain("navigate")
			expect(text).toContain("attach")
			expect(text).toContain("connect")
			expect(text).toContain("close")
		})

		it("renders box-drawing border around the panel", () => {
			const { panel } = makePanel()
			const lines = panel.render(120).map(stripAnsi)
			// Top border
			expect(lines[0]).toMatch(/^╭─.*Sessions.*─╮$/)
			// Bottom border
			expect(lines[lines.length - 1]).toMatch(/^╰─+╯$/)
			// Side borders on content lines
			const contentLines = lines.slice(1, -1)
			for (const line of contentLines) {
				if (line.includes("├") || line.includes("┤")) continue // divider line
				expect(line.startsWith("│")).toBe(true)
				expect(line.endsWith("│")).toBe(true)
			}
		})

		it("selects the first row by default with > marker", () => {
			const { panel } = makePanel()
			const lines = panel.render(120).map(stripAnsi)
			const sess1Line = lines.find((l) => l.includes("sess-1"))
			expect(sess1Line).toBeDefined()
			expect(sess1Line).toMatch(/> .*sess-1/)

			const sess2Line = lines.find((l) => l.includes("sess-2"))
			expect(sess2Line).toBeDefined()
			expect(sess2Line).not.toMatch(/> .*sess-2/)
		})

		it("shows host prefix (first dot-segment)", () => {
			const { panel } = makePanel()
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).toContain("host-a")
			expect(text).toContain("host-b")
			// sess-3 has no host → shows "-"
			const sess3Line = panel
				.render(120)
				.map(stripAnsi)
				.find((l) => l.includes("sess-3"))
			expect(sess3Line).toContain("-")
		})
	})

	describe("keyboard navigation", () => {
		it("down arrow moves selection down", () => {
			const { panel, tui } = makePanel()
			panel.handleInput("\x1b[B") // down arrow
			const lines = panel.render(120).map(stripAnsi)
			const sess2Line = lines.find((l) => l.includes("sess-2"))
			expect(sess2Line).toMatch(/> .*sess-2/)
			expect(tui.requestRender).toHaveBeenCalled()
		})

		it("j key moves selection down", () => {
			const { panel } = makePanel()
			panel.handleInput("j")
			const lines = panel.render(120).map(stripAnsi)
			const sess2Line = lines.find((l) => l.includes("sess-2"))
			expect(sess2Line).toMatch(/> .*sess-2/)
		})

		it("up arrow moves selection up", () => {
			const { panel } = makePanel()
			panel.handleInput("j") // move to sess-2
			panel.handleInput("\x1b[A") // up arrow
			const lines = panel.render(120).map(stripAnsi)
			const sess1Line = lines.find((l) => l.includes("sess-1"))
			expect(sess1Line).toMatch(/> .*sess-1/)
		})

		it("k key moves selection up", () => {
			const { panel } = makePanel()
			panel.handleInput("j") // move to sess-2
			panel.handleInput("k") // back up
			const lines = panel.render(120).map(stripAnsi)
			const sess1Line = lines.find((l) => l.includes("sess-1"))
			expect(sess1Line).toMatch(/> .*sess-1/)
		})

		it("clamps at top when pressing up at index 0", () => {
			const { panel } = makePanel()
			panel.handleInput("\x1b[A") // up at first item
			const lines = panel.render(120).map(stripAnsi)
			const sess1Line = lines.find((l) => l.includes("sess-1"))
			expect(sess1Line).toMatch(/> .*sess-1/)
		})

		it("clamps at bottom when pressing down at last item", () => {
			const { panel } = makePanel()
			panel.handleInput("j") // sess-2
			panel.handleInput("j") // sess-3
			panel.handleInput("j") // should stay at sess-3
			const lines = panel.render(120).map(stripAnsi)
			const sess3Line = lines.find((l) => l.includes("sess-3"))
			expect(sess3Line).toMatch(/> .*sess-3/)
		})
	})

	describe("actions", () => {
		it("a key triggers attach action with selected session", () => {
			const { panel, done } = makePanel()
			panel.handleInput("a")
			expect(done).toHaveBeenCalledWith({ action: "attach", sessionId: "sess-1" })
		})

		it("s key triggers connect action with selected session", () => {
			const { panel, done } = makePanel()
			panel.handleInput("s")
			expect(done).toHaveBeenCalledWith({ action: "connect", sessionId: "sess-1" })
		})

		it("a key after navigation selects correct session", () => {
			const { panel, done } = makePanel()
			panel.handleInput("j") // move to sess-2
			panel.handleInput("a")
			expect(done).toHaveBeenCalledWith({ action: "attach", sessionId: "sess-2" })
		})

		it("s key after navigation selects correct session", () => {
			const { panel, done } = makePanel()
			panel.handleInput("j") // sess-2
			panel.handleInput("j") // sess-3
			panel.handleInput("s")
			expect(done).toHaveBeenCalledWith({ action: "connect", sessionId: "sess-3" })
		})

		it("escape closes without action", () => {
			const { panel, done } = makePanel()
			panel.handleInput("\x1b") // escape
			expect(done).toHaveBeenCalledWith(undefined)
		})

		it("q closes without action", () => {
			const { panel, done } = makePanel()
			panel.handleInput("q")
			expect(done).toHaveBeenCalledWith(undefined)
		})
	})

	describe("scrolling", () => {
		it("shows only a window when rows exceed terminal height", () => {
			const manyRows = Array.from({ length: 20 }, (_, i) =>
				makeRow({ id: `sess-${String(i).padStart(2, "0")}`, name: `session-${i}` }),
			)
			// terminal rows = 12 → maxVisibleRows = 12 - 7 = 5
			const { panel } = makePanel(manyRows, { termRows: 12 })
			const lines = panel.render(120).map(stripAnsi)
			const dataLines = lines.filter((l) => l.includes("sess-"))
			expect(dataLines.length).toBeLessThan(20)
			expect(dataLines.length).toBeLessThanOrEqual(5)
		})

		it("shows ↓ indicator when items are hidden below", () => {
			const manyRows = Array.from({ length: 20 }, (_, i) =>
				makeRow({ id: `sess-${String(i).padStart(2, "0")}`, name: `session-${i}` }),
			)
			const { panel } = makePanel(manyRows, { termRows: 12 })
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).toContain("↓")
			expect(text).toContain("more")
		})

		it("shows ↑ indicator when items are hidden above", () => {
			const manyRows = Array.from({ length: 20 }, (_, i) =>
				makeRow({ id: `sess-${String(i).padStart(2, "0")}`, name: `session-${i}` }),
			)
			const { panel } = makePanel(manyRows, { termRows: 12 })
			// Navigate to the end
			for (let i = 0; i < 19; i++) panel.handleInput("j")
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).toContain("↑")
			expect(text).toContain("more")
		})

		it("shows no scroll indicators when all rows fit", () => {
			const { panel } = makePanel() // 3 rows, terminal 40 rows
			const lines = panel.render(120).map(stripAnsi)
			// Scroll indicators look like "↑ N more" or "↓ N more"
			expect(lines.some((l) => /↑ \d+ more/.test(l))).toBe(false)
			expect(lines.some((l) => /↓ \d+ more/.test(l))).toBe(false)
		})
	})

	describe("factory", () => {
		it("createSessionsPanel returns a panel with dispose", () => {
			const { panel } = makePanel()
			expect(panel).toBeInstanceOf(SessionsPanel)
			expect(typeof panel.dispose).toBe("function")
			expect(typeof panel.invalidate).toBe("function")
			// dispose and invalidate should not throw
			panel.dispose()
			panel.invalidate()
		})
	})
})
