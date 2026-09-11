import { visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it, vi } from "vitest"
import type { QuotaUsage } from "../../../sandbox/cloud/types.js"
import type { QuotaInput } from "./quota-footer.js"
import type { RemoteSessionNode, RemoteWorkspaceNode } from "./remote-sessions-panel.js"
import { createRemoteSessionsPanel, RemoteSessionsPanel } from "./remote-sessions-panel.js"

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
		cpuMillicores: 1500,
		ramBytes: 6442450944,
		pvcSizeBytes: 21474836480,
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

function makePanel(
	nodes: RemoteWorkspaceNode[] = treeNodes,
	opts?: { termRows?: number; termCols?: number; quota?: QuotaInput },
) {
	const tui = {
		requestRender: vi.fn(),
		terminal: { rows: opts?.termRows ?? 40, cols: opts?.termCols ?? 120 },
	}
	const done = vi.fn()
	const panel = createRemoteSessionsPanel(nodes, tui, done, opts?.quota)
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

	describe("resource columns", () => {
		it("shows resource values on workspace rows only; session rows stay blank", () => {
			const { panel } = makePanel()
			const lines = panel.render(120).map(stripAnsi)
			const wsLine = lines.find((l) => l.includes("alpha"))
			const sessionLine = lines.find((l) => l.includes("pty-abc12"))
			expect(wsLine).toContain("1500m")
			expect(wsLine).toContain("6Gi")
			expect(wsLine).toContain("20Gi")
			expect(sessionLine).not.toContain("1500m")
			expect(sessionLine).not.toContain("6Gi")
			expect(sessionLine).not.toContain("20Gi")
		})

		it("renders '-' on workspace rows when the server omitted resource fields", () => {
			const { panel } = makePanel([
				node({
					row: {
						id: "ws-x",
						name: "gamma",
						status: "active",
						sessionCount: 0,
						cpuMillicores: undefined,
						ramBytes: undefined,
						pvcSizeBytes: undefined,
					},
				}),
			])
			const line = panel
				.render(120)
				.map(stripAnsi)
				.find((l) => l.includes("gamma"))
			// CPU, RAM and PVC cells are the only dash sources on this line
			// (name/status/relative times never contain dashes).
			expect((line?.match(/-/g) ?? []).length).toBe(3)
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

	describe("details overlay", () => {
		it("'i' shows workspace details including host, id and status", () => {
			const { panel } = makePanel()
			panel.handleInput("i")
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).toContain("Type")
			expect(text).toContain("workspace")
			expect(text).toContain("Host")
			expect(text).toContain("host.example")
			expect(text).toContain("ws-aaaaaaaa-1")
			expect(text).toContain("active")
			expect(text).not.toContain("NAME / SESSION")
		})

		it("'i' shows the workspace's resource requests in details", () => {
			const { panel } = makePanel()
			panel.handleInput("i")
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).toContain("CPU")
			expect(text).toContain("1500m")
			expect(text).toContain("RAM")
			expect(text).toContain("6Gi")
			expect(text).toContain("PVC")
			expect(text).toContain("20Gi")
		})

		it("'i' shows '-' for resource fields the server omitted", () => {
			const { panel } = makePanel([
				node({
					row: {
						id: "ws-x",
						name: "gamma",
						status: "active",
						sessionCount: 0,
						cpuMillicores: undefined,
						ramBytes: undefined,
						pvcSizeBytes: undefined,
					},
				}),
			])
			panel.handleInput("i")
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).toMatch(/CPU\s+-/)
			expect(text).toMatch(/RAM\s+-/)
			expect(text).toMatch(/PVC\s+-/)
		})

		it("'i' on a session shows session details including workspace host", () => {
			const { panel } = makePanel()
			panel.handleInput("j")
			panel.handleInput("i")
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).toContain("session")
			expect(text).toContain("pty-abc12")
			expect(text).toContain("Workspace Host")
			expect(text).toContain("host.example")
			expect(text).toContain("Client connected")
			expect(text).toContain("yes")
		})

		it("'i' toggles back to the table", () => {
			const { panel } = makePanel()
			panel.handleInput("i")
			panel.handleInput("i")
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).toContain("NAME / SESSION")
			expect(text).not.toContain("Workspace Host")
		})

		it("esc closes details instead of the panel", () => {
			const { panel, done } = makePanel()
			panel.handleInput("i")
			panel.handleInput("\x1b")
			expect(done).not.toHaveBeenCalled()
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).toContain("NAME / SESSION")
		})

		it("navigation and action keys are inert while details are open", () => {
			const { panel, done } = makePanel()
			panel.handleInput("i")
			panel.handleInput("j")
			panel.handleInput("\r")
			panel.handleInput("d")
			panel.handleInput("r")
			expect(done).not.toHaveBeenCalled()
		})

		it("'i' is a no-op when the tree is empty", () => {
			const { panel, done } = makePanel([])
			panel.handleInput("i")
			expect(done).not.toHaveBeenCalled()
			const text = panel.render(120).map(stripAnsi).join("\n")
			expect(text).toContain("(no workspaces)")
		})

		it("emits the same line count with details open as with the table", () => {
			const { panel } = makePanel(treeNodes, { termRows: 20 })
			const baseline = panel.render(120).length
			panel.handleInput("i")
			expect(panel.render(120).length).toBe(baseline)
		})
	})

	describe("quota summary", () => {
		const quota: QuotaUsage = {
			userUsage: {
				currentSandboxes: 3,
				maxSandboxes: 10,
				currentCpuMillicores: 4500,
				maxCpuMillicores: 16000,
				currentRamBytes: 6442450944,
				maxRamBytes: 17179869184,
				currentPvcSizeBytes: 21474836480,
				maxPvcSizeBytes: 128849018880,
			},
			orgUsage: {
				currentSandboxes: 7,
				maxSandboxes: 10,
				currentCpuMillicores: 9000,
				maxCpuMillicores: 16000,
				currentRamBytes: 6442450944,
				maxRamBytes: 17179869184,
				currentPvcSizeBytes: 32212254720,
				maxPvcSizeBytes: 429496729600,
			},
		}

		const summaryLine = (panel: RemoteSessionsPanel): string | undefined =>
			panel
				.render(120)
				.map(stripAnsi)
				.find((l) => l.includes("you:"))

		const orgLine = (panel: RemoteSessionsPanel): string | undefined =>
			panel
				.render(120)
				.map(stripAnsi)
				.find((l) => l.includes("org:"))

		it("renders the usage-vs-quota summary as two lines: user first, org below", () => {
			const { panel } = makePanel(treeNodes, { quota })
			const line = summaryLine(panel)
			expect(line).toContain("you: 4500m/16000m CPU · 6Gi/16Gi RAM · 20Gi/120Gi PVC · 3/10 workspaces")
			expect(line).not.toContain("org:")
			expect(orgLine(panel)).toContain("org: 9000m/16000m CPU · 6Gi/16Gi RAM · 30Gi/400Gi PVC · 7/10 workspaces")
		})

		it("renders current and max RAM in one shared unit, decimals on the current side when needed", () => {
			const { panel } = makePanel(treeNodes, {
				quota: {
					userUsage: {
						currentSandboxes: 2,
						maxSandboxes: 10,
						currentCpuMillicores: 1700,
						maxCpuMillicores: 3000,
						currentRamBytes: 1610612736, // 1.5 Gi
						maxRamBytes: 128849018880, // 120 Gi
					},
				},
			})
			const line = summaryLine(panel)
			expect(line).toContain("you: 1700m/3000m CPU · 1.5Gi/120Gi RAM · 2/10 workspaces")
		})

		it("renders only the user scope when org usage is missing", () => {
			const { panel } = makePanel(treeNodes, { quota: { userUsage: quota.userUsage } })
			const line = summaryLine(panel)
			expect(line).toContain("you: 4500m/16000m CPU")
			expect(line).not.toContain("org:")
			expect(orgLine(panel)).toBeUndefined()
		})

		it("drops segments whose fields are missing", () => {
			const { panel } = makePanel(treeNodes, {
				quota: { userUsage: { currentSandboxes: 1, maxSandboxes: 5 } },
			})
			const line = summaryLine(panel)
			expect(line).toContain("you: 1/5 workspaces")
			expect(line).not.toContain("CPU")
			expect(line).not.toContain("RAM")
			expect(line).not.toContain("PVC")
		})

		it("renders a PVC segment when only PVC fields are present", () => {
			const { panel } = makePanel(treeNodes, {
				quota: { userUsage: { currentPvcSizeBytes: 5368709120, maxPvcSizeBytes: 107374182400 } },
			})
			const line = summaryLine(panel)
			expect(line).toContain("you: 5Gi/100Gi PVC")
			expect(line).not.toContain("CPU")
			expect(line).not.toContain("RAM")
			expect(line).not.toContain("workspaces")
		})

		it("omits the summary line entirely when no quota was fetched, keeping the line count constant", () => {
			const withQuota = makePanel(treeNodes, { quota, termRows: 20 })
			const without = makePanel(treeNodes, { termRows: 20 })
			expect(without.panel.render(120).length).toBe(withQuota.panel.render(120).length)
			expect(summaryLine(without.panel)).toBeUndefined()
		})

		it("omits the summary when the quota carries no usable fields", () => {
			const { panel } = makePanel(treeNodes, { quota: {} })
			expect(summaryLine(panel)).toBeUndefined()
		})

		it("fills the summary in when an in-flight quota fetch settles", async () => {
			const quotaPromise = Promise.resolve(quota)
			const { panel, tui } = makePanel(treeNodes, { quota: quotaPromise })
			expect(summaryLine(panel)).toBeUndefined()
			await quotaPromise
			expect(tui.requestRender).toHaveBeenCalled()
			expect(summaryLine(panel)).toContain("you: 4500m/16000m CPU")
		})

		it("keeps the summary empty when the quota promise rejects", async () => {
			const failing = Promise.reject(new Error("boom"))
			const { panel } = makePanel(treeNodes, { quota: failing })
			await failing.catch(() => undefined)
			expect(summaryLine(panel)).toBeUndefined()
		})

		it("ignores a quota fetch that settles after the panel was disposed", async () => {
			const quotaPromise = Promise.resolve(quota)
			const { panel, tui } = makePanel(treeNodes, { quota: quotaPromise })
			panel.dispose()
			await quotaPromise
			expect(tui.requestRender).not.toHaveBeenCalled()
			expect(summaryLine(panel)).toBeUndefined()
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

	describe("narrow terminals", () => {
		it("keeps the NAME flex column at MIN_COL_WIDTH when the fixed resource columns crowd the row", () => {
			const { panel } = makePanel([
				node({ row: { id: "ws-long-1", name: "abcdefghijklmnop", status: "active", sessionCount: 0 } }),
			])
			const lines = panel.render(60).map(stripAnsi)
			const line = lines.find((l) => l.includes("> "))
			// The name truncates but never below MIN_COL_WIDTH: a width-8 cell
			// still shows 7 name characters plus the ellipsis.
			expect(line).toContain("abcdefg")
			// The fixed resource columns are never squeezed: their headers
			// survive intact on the header row.
			const header = lines.find((l) => l.includes("NAME / SESSION"))
			expect(header).toContain("CPU")
			expect(header).toContain("RAM")
			expect(header).toContain("PVC")
		})

		// Regression: border title math produced a negative "─".repeat count
		// below the title width, crashing with RangeError.
		for (const width of [1, 2, 3, 4, 5, 8, 10, 16, 24]) {
			it(`renders without crashing or overflowing at width ${width}`, () => {
				const { panel } = makePanel()
				let lines: string[] = []
				expect(() => {
					lines = panel.render(width)
				}).not.toThrow()
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width)
				}
			})
		}
	})
})
