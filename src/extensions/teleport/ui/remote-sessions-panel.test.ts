import { describe, expect, it, vi } from "vitest"
import { RemoteSessionsPanel, createRemoteSessionsPanel } from "./remote-sessions-panel.js"
import type { RemoteSessionNode, RemoteWorkspaceNode } from "./remote-sessions-panel.js"

const NOW = new Date("2026-05-17T12:00:00Z")

function session(over: Partial<RemoteSessionNode> = {}): RemoteSessionNode {
	return {
		workspaceId: "ws-aaaaaaaa-1",
		workspaceName: "alpha",
		sessionName: "pty-abc12",
		status: "active",
		clientConnected: true,
		lastActivityAt: new Date(NOW.getTime() - 60_000),
		...over,
	}
}

function node(over: Partial<RemoteWorkspaceNode> = {}): RemoteWorkspaceNode {
	const row: RemoteWorkspaceNode["row"] = {
		id: "ws-aaaaaaaa-1",
		name: "alpha",
		status: "active",
		createdAt: new Date(NOW.getTime() - 3_600_000),
		lastActivityAt: new Date(NOW.getTime() - 60_000),
		host: "host.example",
		sessionCount: 2,
		...over.row,
	}
	return {
		row,
		sessions: over.sessions ?? [],
		unreachable: over.unreachable ?? false,
	}
}

const treeNodes: RemoteWorkspaceNode[] = [
	node({
		row: { id: "ws-aaaaaaaa-1", name: "alpha", status: "active", sessionCount: 2 },
		sessions: [
			session({ sessionName: "pty-abc12", status: "active", clientConnected: true }),
			session({ sessionName: "pty-def34", status: "disconnected", clientConnected: false }),
		],
	}),
	node({
		row: { id: "ws-bbbbbbbb-2", name: "beta", status: "idle", sessionCount: 0 },
		sessions: [],
	}),
]

function makePanel(nodes: RemoteWorkspaceNode[] = treeNodes, opts?: { termRows?: number; termCols?: number }) {
	const tui = {
		requestRender: vi.fn(),
		terminal: { rows: opts?.termRows ?? 40, cols: opts?.termCols ?? 120 },
	}
	const done = vi.fn()
	const panel = createRemoteSessionsPanel(nodes, tui, done)
	return { panel, tui, done }
}

function stripAnsi(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: needed for ANSI stripping
	return s.replace(/\x1b\[[0-9;]*m/g, "")
}

function selectedLine(panel: RemoteSessionsPanel): string | undefined {
	return panel
		.render(120)
		.map(stripAnsi)
		.find((l) => l.includes("> "))
}

describe("RemoteSessionsPanel", () => {
	describe("render", () => {
		it("renders title, headers, hint, workspaces and nested sessions with connectors", () => {
			const { panel } = makePanel()
			const text = panel.render(120).map(stripAnsi).join("\n")

			expect(text).toContain("Remote Sessions")
			expect(text).toContain("NAME / SESSION")
			expect(text).toContain("STATUS")
			expect(text).toContain("LAST ACTIVITY")
			expect(text).toContain("alpha")
			expect(text).toContain("beta")
			expect(text).toContain("pty-abc12")
			expect(text).toContain("pty-def34")
			// tree connectors: non-last session uses ├─, last uses └─
			expect(text).toContain("├─ pty-abc12")
			expect(text).toContain("└─ pty-def34")
			expect(text).toContain("navigate")
			expect(text).toContain("rename")
		})

		it("renders unreachable status for a workspace whose worker failed, and no children", () => {
			const { panel } = makePanel([
				node({ row: { id: "ws-x", name: "gamma", status: "active", sessionCount: "?" }, unreachable: true }),
			])
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).toContain("gamma")
			expect(text).toContain("unreachable")
		})

		it("renders '(no workspaces)' when empty", () => {
			const { panel } = makePanel([])
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).toContain("(no workspaces)")
		})
	})

	describe("navigation", () => {
		it("walks across workspace and session entries with j/k", () => {
			const { panel } = makePanel()
			// entries: [alpha, pty-abc12, pty-def34, beta]
			expect(selectedLine(panel)).toContain("alpha")
			panel.handleInput("j")
			expect(selectedLine(panel)).toContain("pty-abc12")
			panel.handleInput("j")
			expect(selectedLine(panel)).toContain("pty-def34")
			panel.handleInput("j")
			expect(selectedLine(panel)).toContain("beta")
			panel.handleInput("k")
			expect(selectedLine(panel)).toContain("pty-def34")
		})

		it("clamps at top and bottom", () => {
			const { panel } = makePanel()
			panel.handleInput("k")
			expect(selectedLine(panel)).toContain("alpha")
			for (let i = 0; i < 10; i++) panel.handleInput("j")
			expect(selectedLine(panel)).toContain("beta")
		})
	})

	describe("actions", () => {
		it("Enter on a workspace resolves action='open-terminal'", () => {
			const { panel, done } = makePanel()
			panel.handleInput("\r")
			expect(done).toHaveBeenCalledWith({ action: "open-terminal", node: treeNodes[0] })
		})

		it("Enter on a session resolves action='open-session'", () => {
			const { panel, done } = makePanel()
			panel.handleInput("j")
			panel.handleInput("\r")
			expect(done).toHaveBeenCalledWith({ action: "open-session", node: treeNodes[0]?.sessions[0] })
		})

		it("'d' on a workspace resolves action='delete-workspace'", () => {
			const { panel, done } = makePanel()
			panel.handleInput("d")
			expect(done).toHaveBeenCalledWith({ action: "delete-workspace", node: treeNodes[0] })
		})

		it("'d' on a session resolves action='delete-session'", () => {
			const { panel, done } = makePanel()
			panel.handleInput("j")
			panel.handleInput("d")
			expect(done).toHaveBeenCalledWith({ action: "delete-session", node: treeNodes[0]?.sessions[0] })
		})

		it("'r' on a workspace resolves action='rename-workspace'", () => {
			const { panel, done } = makePanel()
			panel.handleInput("r")
			expect(done).toHaveBeenCalledWith({ action: "rename-workspace", node: treeNodes[0] })
		})

		it("'r' is a no-op on a session entry (no session rename)", () => {
			const { panel, done } = makePanel()
			panel.handleInput("j")
			panel.handleInput("r")
			expect(done).not.toHaveBeenCalled()
		})

		it("Esc / q / x resolve done with undefined", () => {
			for (const key of ["\x1b", "q", "x"]) {
				const { panel, done } = makePanel()
				panel.handleInput(key)
				expect(done).toHaveBeenCalledWith(undefined)
			}
		})

		it("Enter and 'd' are no-ops when the tree is empty", () => {
			const { panel, done } = makePanel([])
			panel.handleInput("\r")
			panel.handleInput("d")
			expect(done).not.toHaveBeenCalled()
		})
	})

	describe("stable height", () => {
		it("emits the same line count across navigation when entries exceed viewport", () => {
			const manyNodes: RemoteWorkspaceNode[] = Array.from({ length: 12 }, (_, i) =>
				node({
					row: { id: `ws-${i}`, name: `n-${i}`, status: "active", sessionCount: 1 },
					sessions: [session({ workspaceId: `ws-${i}`, sessionName: `s-${i}` })],
				}),
			)
			const { panel } = makePanel(manyNodes, { termRows: 18 })
			const baseline = panel.render(120).length
			for (let i = 0; i < 23; i++) {
				panel.handleInput("j")
				expect(panel.render(120).length).toBe(baseline)
			}
		})

		it("emits the same line count for empty and populated trees", () => {
			const { panel: empty } = makePanel([], { termRows: 20 })
			const { panel: full } = makePanel(treeNodes, { termRows: 20 })
			expect(empty.render(120).length).toBe(full.render(120).length)
		})
	})

	describe("direct instantiation", () => {
		it("can be constructed without the helper", () => {
			const tui = { requestRender: vi.fn(), terminal: { rows: 24, cols: 80 } }
			const done = vi.fn()
			const panel = new RemoteSessionsPanel(treeNodes, tui, done)
			expect(panel.render(80).length).toBeGreaterThan(0)
		})
	})
})
