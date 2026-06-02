import { describe, expect, it, vi } from "vitest"
import { WorkspacesPanel, createWorkspacesPanel } from "./workspaces-panel.js"
import type { WorkspaceRow } from "./workspaces-table.js"

const NOW = new Date("2026-05-17T12:00:00Z")

function makeRow(overrides: Partial<WorkspaceRow> = {}): WorkspaceRow {
	return {
		id: "w-12345678abcdef",
		name: "alpha",
		status: "active",
		createdAt: new Date(NOW.getTime() - 3_600_000),
		lastActivityAt: new Date(NOW.getTime() - 60_000),
		host: "host.example",
		sessionCount: 2,
		...overrides,
	}
}

const testRows: WorkspaceRow[] = [
	makeRow({ id: "ws-aaaaaaaa-1", name: "alpha", status: "active", sessionCount: 3 }),
	makeRow({ id: "ws-bbbbbbbb-2", name: "beta", status: "idle", sessionCount: 0 }),
	makeRow({ id: "ws-cccccccc-3", name: "gamma", status: "completed", sessionCount: "?" }),
]

function makePanel(rows: WorkspaceRow[] = testRows, opts?: { termRows?: number; termCols?: number }) {
	const tui = {
		requestRender: vi.fn(),
		terminal: { rows: opts?.termRows ?? 40, cols: opts?.termCols ?? 120 },
	}
	const done = vi.fn()
	const panel = createWorkspacesPanel(rows, tui, done)
	return { panel, tui, done }
}

function stripAnsi(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: needed for ANSI stripping
	return s.replace(/\x1b\[[0-9;]*m/g, "")
}

describe("WorkspacesPanel", () => {
	describe("render", () => {
		it("renders title, header, all rows, and hint line", () => {
			const { panel } = makePanel()
			const text = panel.render(120).map(stripAnsi).join("\n")

			expect(text).toContain("Workspaces")
			expect(text).toContain("NAME")
			expect(text).toContain("ID")
			expect(text).toContain("STATUS")
			expect(text).toContain("CREATED")
			expect(text).toContain("LAST ACTIVITY")
			expect(text).toContain("SESSIONS")
			expect(text).toContain("HOST")
			expect(text).toContain("alpha")
			expect(text).toContain("beta")
			expect(text).toContain("gamma")
			expect(text).toContain("navigate")
			expect(text).toContain("terminal")
			expect(text).toContain("delete")
			expect(text).toContain("close")
		})

		it("shows a short id (first 8 chars) for each workspace row", () => {
			const { panel } = makePanel([makeRow({ id: "abcdef0123456789", name: "alpha" })])
			const text = panel.render(120).map(stripAnsi).join("\n")

			expect(text).toContain("abcdef01")
			expect(text).not.toContain("abcdef0123456789")
		})

		it("renders '?' for unknown session count", () => {
			const { panel } = makePanel([makeRow({ name: "gamma", sessionCount: "?" })])
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).toContain("?")
		})

		it("renders a numeric session count when known", () => {
			const { panel } = makePanel([makeRow({ name: "alpha", sessionCount: 7 })])
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).toContain("7")
		})

		it("renders '(no workspaces)' when rows are empty", () => {
			const { panel } = makePanel([])
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).toContain("(no workspaces)")
		})

		it("renders '-' for missing name and host", () => {
			const { panel } = makePanel([makeRow({ name: "", host: undefined })])
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).toContain("-")
		})
	})

	describe("navigation", () => {
		it("moves selection down with j and up with k", () => {
			const { panel, tui } = makePanel()
			panel.handleInput("j")
			expect(tui.requestRender).toHaveBeenCalled()
			panel.handleInput("j")
			panel.handleInput("k")
			// selection lands on index 1 (down, down, up)
			const text = panel.render(120).map(stripAnsi).join("\n")
			const lines = text.split("\n")
			const selectedLine = lines.find((l) => l.includes("> "))
			expect(selectedLine).toContain("beta")
		})

		it("clamps at the top and bottom", () => {
			const { panel } = makePanel()
			panel.handleInput("k")
			panel.handleInput("k")
			// still at top
			let lines = panel.render(120).map(stripAnsi).join("\n").split("\n")
			let selected = lines.find((l) => l.includes("> "))
			expect(selected).toContain("alpha")

			panel.handleInput("j")
			panel.handleInput("j")
			panel.handleInput("j")
			panel.handleInput("j")
			// clamps at last row
			lines = panel.render(120).map(stripAnsi).join("\n").split("\n")
			selected = lines.find((l) => l.includes("> "))
			expect(selected).toContain("gamma")
		})
	})

	describe("actions", () => {
		it("Enter on a row resolves done with action='terminal'", () => {
			const { panel, done } = makePanel()
			panel.handleInput("\r")
			expect(done).toHaveBeenCalledWith({ action: "terminal", row: testRows[0] })
		})

		it("'d' on a row resolves done with action='delete'", () => {
			const { panel, done } = makePanel()
			panel.handleInput("d")
			expect(done).toHaveBeenCalledWith({ action: "delete", row: testRows[0] })
		})

		it("Esc resolves done with undefined", () => {
			const { panel, done } = makePanel()
			panel.handleInput("\x1b")
			expect(done).toHaveBeenCalledWith(undefined)
		})

		it("'q' resolves done with undefined", () => {
			const { panel, done } = makePanel()
			panel.handleInput("q")
			expect(done).toHaveBeenCalledWith(undefined)
		})

		it("'x' resolves done with undefined", () => {
			const { panel, done } = makePanel()
			panel.handleInput("x")
			expect(done).toHaveBeenCalledWith(undefined)
		})

		it("Enter and 'd' are no-ops when the rows array is empty", () => {
			const { panel, done } = makePanel([])
			panel.handleInput("\r")
			panel.handleInput("d")
			expect(done).not.toHaveBeenCalled()
		})
	})

	describe("WorkspacesPanel direct instantiation", () => {
		it("can be constructed without the createWorkspacesPanel helper", () => {
			const tui = { requestRender: vi.fn(), terminal: { rows: 24, cols: 80 } }
			const done = vi.fn()
			const panel = new WorkspacesPanel(testRows, tui, done)
			expect(panel.render(80).length).toBeGreaterThan(0)
		})
	})
})
