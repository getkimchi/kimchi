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

function makePanel(
	rows: WorkspaceRow[] = testRows,
	opts?: {
		termRows?: number
		termCols?: number
		allowNew?: boolean
		allowDelete?: boolean
		allowRename?: boolean
		hideSessions?: boolean
	},
) {
	const tui = {
		requestRender: vi.fn(),
		terminal: { rows: opts?.termRows ?? 40, cols: opts?.termCols ?? 120 },
	}
	const done = vi.fn()
	const panel = createWorkspacesPanel(rows, tui, done, {
		allowNew: opts?.allowNew,
		allowDelete: opts?.allowDelete ?? true,
		allowRename: opts?.allowRename,
		hideSessions: opts?.hideSessions,
	})
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
			expect(text).toContain("select")
			expect(text).toContain("delete")
			expect(text).toContain("cancel")
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
		it("Enter on a row resolves done with action='select'", () => {
			const { panel, done } = makePanel()
			panel.handleInput("\r")
			expect(done).toHaveBeenCalledWith({ action: "select", row: testRows[0] })
		})

		it("'d' on a row resolves done with action='delete' when allowDelete=true", () => {
			const { panel, done } = makePanel()
			panel.handleInput("d")
			expect(done).toHaveBeenCalledWith({ action: "delete", row: testRows[0] })
		})

		it("'d' is a no-op when allowDelete=false (default-off pathway)", () => {
			const { panel, done } = makePanel(testRows, { allowDelete: false })
			panel.handleInput("d")
			expect(done).not.toHaveBeenCalled()
		})

		it("'r' on a row resolves done with action='rename' when allowRename=true", () => {
			const { panel, done } = makePanel(testRows, { allowRename: true })
			panel.handleInput("r")
			expect(done).toHaveBeenCalledWith({ action: "rename", row: testRows[0] })
		})

		it("'r' is a no-op when allowRename=false (default)", () => {
			const { panel, done } = makePanel(testRows, { allowRename: false })
			panel.handleInput("r")
			expect(done).not.toHaveBeenCalled()
		})

		it("'r' is a no-op on the synthetic '+ new' row even with allowRename=true", () => {
			const { panel, done } = makePanel(testRows, { allowRename: true, allowNew: true })
			// move past all real rows onto the synthetic '+ new' entry
			panel.handleInput("j")
			panel.handleInput("j")
			panel.handleInput("j")
			panel.handleInput("r")
			expect(done).not.toHaveBeenCalled()
		})

		it("'n' is a no-op when allowNew=false (default)", () => {
			const { panel, done } = makePanel()
			panel.handleInput("n")
			expect(done).not.toHaveBeenCalled()
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

	describe("allowRename", () => {
		it("shows 'r: rename' in the hint footer when allowRename=true", () => {
			const { panel } = makePanel(testRows, { allowRename: true })
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).toContain("r: rename")
		})

		it("does NOT show 'r: rename' when allowRename=false", () => {
			const { panel } = makePanel()
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).not.toContain("r: rename")
		})
	})

	describe("allowNew", () => {
		it("appends a '+ new workspace' row when allowNew=true", () => {
			const { panel } = makePanel(testRows, { allowNew: true })
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).toContain("+ new workspace")
			expect(text).toContain("n: new")
		})

		it("does NOT render '+ new workspace' when allowNew=false", () => {
			const { panel } = makePanel()
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).not.toContain("+ new workspace")
		})

		it("'n' resolves done with action='new' when allowNew=true", () => {
			const { panel, done } = makePanel(testRows, { allowNew: true })
			panel.handleInput("n")
			expect(done).toHaveBeenCalledWith({ action: "new" })
		})

		it("Enter on the synthetic '+ new' row resolves done with action='new'", () => {
			const { panel, done } = makePanel(testRows, { allowNew: true })
			// 3 rows + 1 synthetic = 4 entries; press down 3 times to land on the new row
			panel.handleInput("j")
			panel.handleInput("j")
			panel.handleInput("j")
			panel.handleInput("\r")
			expect(done).toHaveBeenCalledWith({ action: "new" })
		})
	})

	describe("stable height", () => {
		it("emits the same line count across navigation when entries exceed viewport", () => {
			const manyRows: WorkspaceRow[] = Array.from({ length: 25 }, (_, i) =>
				makeRow({ id: `ws-${i.toString().padStart(8, "0")}`, name: `n-${i}` }),
			)
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

	describe("hideSessions", () => {
		it("omits the SESSIONS column from the header and body", () => {
			const { panel } = makePanel(testRows, { hideSessions: true })
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).not.toContain("SESSIONS")
			// Other columns are still there
			expect(text).toContain("NAME")
			expect(text).toContain("HOST")
		})
	})
})
