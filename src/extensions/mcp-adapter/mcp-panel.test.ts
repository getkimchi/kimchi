import { describe, expect, it, vi } from "vitest"
import { createMcpPanel, computeVisibleWindow } from "./mcp-panel.js"
import type { McpConfig, McpPanelCallbacks, McpPanelResult, ServerProvenance } from "./types.js"
import type { MetadataCache } from "./metadata-cache.js"

// ─── Panel test helpers ───────────────────────────────────────────────────────

/** Minimal McpConfig with one server and one cached tool. */
function makeConfig(serverName = "my-server"): McpConfig {
	return {
		mcpServers: {
			[serverName]: { command: "npx", args: ["my-server"] },
		},
	}
}

/** MetadataCache with one tool cached for the given server. */
function makeCache(serverName = "my-server", toolName = "my_tool", description = "Does a thing"): MetadataCache {
	return {
		version: 1,
		servers: {
			[serverName]: {
				configHash: "abc",
				tools: [{ name: toolName, description }],
				resources: [],
				cachedAt: Date.now(),
			},
		},
	}
}

/** Stub callbacks — all no-ops except onSave which uses a vi.fn(). */
function makeCallbacks(): { callbacks: McpPanelCallbacks; onSave: ReturnType<typeof vi.fn> } {
	const onSave = vi.fn<(changes: Map<string, true | string[] | false>) => void>()
	const callbacks: McpPanelCallbacks = {
		reconnect: () => Promise.resolve(true),
		getConnectionStatus: () => "connected",
		refreshCacheAfterReconnect: () => null,
		onSave,
	}
	return { callbacks, onSave }
}

/** Stub TUI — captures requestRender calls. */
function makeTui(rows = 40): { requestRender: ReturnType<typeof vi.fn>; terminal: { rows: number } } {
	return { requestRender: vi.fn(), terminal: { rows } }
}

/** Empty provenance map (all servers treated as user-config). */
function makeProvenance(serverName = "my-server", path = "/tmp/mcp-test.json"): Map<string, ServerProvenance> {
	return new Map([[serverName, { path, kind: "user" }]])
}

/**
 * Create a panel and return it together with its callbacks and a done spy.
 * The panel starts with the server row focused (cursorIndex = 0).
 */
function makePanel(opts?: {
	config?: McpConfig
	cache?: MetadataCache | null
	provenance?: Map<string, ServerProvenance>
	serverName?: string
}) {
	const serverName = opts?.serverName ?? "my-server"
	const config = opts?.config ?? makeConfig(serverName)
	const cache = opts?.cache !== undefined ? opts.cache : makeCache(serverName)
	const provenance = opts?.provenance ?? makeProvenance(serverName)
	const { callbacks, onSave } = makeCallbacks()
	const tui = makeTui()
	const done = vi.fn<(result: McpPanelResult) => void>()
	const panel = createMcpPanel(config, cache, provenance, callbacks, tui, done)
	return { panel, callbacks, onSave, tui, done }
}

/**
 * Strip ANSI escape sequences from a string so assertions on rendered text
 * work without depending on exact color codes.
 */
function stripAnsi(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: needed to strip ANSI
	return s.replace(/\x1b\[[\d;]*[A-Za-z]/g, "")
}

/** Collect all rendered lines as plain text (ANSI stripped). */
function renderText(panel: ReturnType<typeof createMcpPanel>, width = 80): string[] {
	return panel.render(width).map(stripAnsi)
}

const LIMITS = { maxVisible: 12, minVisible: 3, fixedOverheadRows: 16 }

describe("computeVisibleWindow", () => {
	describe("maxVis clamping by terminal height", () => {
		it("clamps to MIN_VISIBLE when terminal is too small (rows < overhead)", () => {
			const { maxVis } = computeVisibleWindow(5, 0, 50, LIMITS)
			expect(maxVis).toBe(3)
		})

		it("clamps to MIN_VISIBLE when terminal exactly matches overhead", () => {
			const { maxVis } = computeVisibleWindow(16, 0, 50, LIMITS)
			expect(maxVis).toBe(3)
		})

		it("scales with terminal height between MIN and MAX", () => {
			const { maxVis } = computeVisibleWindow(20, 0, 50, LIMITS)
			expect(maxVis).toBe(4)
		})

		it("clamps to MAX_VISIBLE when terminal is large enough", () => {
			const { maxVis } = computeVisibleWindow(28, 0, 50, LIMITS)
			expect(maxVis).toBe(12)
		})

		it("stays at MAX_VISIBLE for very large terminals", () => {
			const { maxVis } = computeVisibleWindow(100, 0, 50, LIMITS)
			expect(maxVis).toBe(12)
		})
	})

	describe("startIdx/endIdx windowing", () => {
		it("starts at 0 when cursor is at the top", () => {
			const { startIdx, endIdx } = computeVisibleWindow(100, 0, 78, LIMITS)
			expect(startIdx).toBe(0)
			expect(endIdx).toBe(12)
		})

		it("centers cursor in the middle of the list", () => {
			const { startIdx, endIdx } = computeVisibleWindow(100, 40, 78, LIMITS)
			expect(startIdx).toBe(34)
			expect(endIdx).toBe(46)
		})

		it("clamps startIdx so the window stays within total at end of list", () => {
			const { startIdx, endIdx } = computeVisibleWindow(100, 77, 78, LIMITS)
			expect(startIdx).toBe(66)
			expect(endIdx).toBe(78)
		})

		it("does not exceed total when list is shorter than maxVis", () => {
			const { startIdx, endIdx } = computeVisibleWindow(100, 0, 5, LIMITS)
			expect(startIdx).toBe(0)
			expect(endIdx).toBe(5)
		})

		it("does not exceed total when list is exactly maxVis", () => {
			const { startIdx, endIdx } = computeVisibleWindow(100, 6, 12, LIMITS)
			expect(startIdx).toBe(0)
			expect(endIdx).toBe(12)
		})

		it("handles empty list gracefully", () => {
			const { startIdx, endIdx } = computeVisibleWindow(100, 0, 0, LIMITS)
			expect(startIdx).toBe(0)
			expect(endIdx).toBe(0)
		})
	})

	describe("interaction between small terminal and large list", () => {
		it("scrolls correctly with reduced maxVis on small terminal", () => {
			const { maxVis, startIdx, endIdx } = computeVisibleWindow(20, 50, 78, LIMITS)
			expect(maxVis).toBe(4)
			expect(startIdx).toBe(48)
			expect(endIdx).toBe(52)
		})

		it("end-of-list windowing works on small terminal", () => {
			const { maxVis, startIdx, endIdx } = computeVisibleWindow(20, 77, 78, LIMITS)
			expect(maxVis).toBe(4)
			expect(startIdx).toBe(74)
			expect(endIdx).toBe(78)
		})
	})
})

// ─── ctrl+s save behaviour ───────────────────────────────────────────────────────────────

describe("McpPanel ctrl+s", () => {
	const CTRL_S = "\x13"

	it("does nothing when there are no changes", () => {
		const { panel, onSave, tui } = makePanel()
		panel.handleInput(CTRL_S)
		expect(onSave).not.toHaveBeenCalled()
		// render is still requested so the panel redraws (clears any stale notice)
		expect(tui.requestRender).toHaveBeenCalled()
	})

	it("calls onSave with the correct changes map after toggling a tool", () => {
		const { panel, onSave } = makePanel()

		// Expand the server (cursor is on server row, press return)
		panel.handleInput("\r")
		// Move down to the tool row
		panel.handleInput("\x1b[B")
		// Toggle the tool direct (space bar)
		panel.handleInput(" ")
		// Save
		panel.handleInput(CTRL_S)

		expect(onSave).toHaveBeenCalledOnce()
		const [changesArg] = onSave.mock.calls[0] as [Map<string, true | string[] | false>]
		// Tool was off (false) by default; toggled to on. With 1 out of 1 tools
		// direct, buildResult emits `true` for the server.
		expect(changesArg.get("my-server")).toBe(true)
	})

	it("commits the new baseline so a second ctrl+s does not call onSave again", () => {
		const { panel, onSave } = makePanel()

		panel.handleInput("\r") // expand
		panel.handleInput("\x1b[B") // move to tool
		panel.handleInput(" ") // toggle
		panel.handleInput(CTRL_S) // save — should fire onSave
		panel.handleInput(CTRL_S) // save again — no new changes, should NOT fire again

		expect(onSave).toHaveBeenCalledOnce()
	})

	it("shows the save notice in the rendered output after saving", () => {
		const { panel } = makePanel()

		panel.handleInput("\r")
		panel.handleInput("\x1b[B")
		panel.handleInput(" ")
		panel.handleInput(CTRL_S)

		const lines = renderText(panel)
		const hasSaveNotice = lines.some((l) => l.includes("Saved"))
		expect(hasSaveNotice).toBe(true)
	})

	it("clears the save notice on the next keypress", () => {
		const { panel } = makePanel()

		panel.handleInput("\r")
		panel.handleInput("\x1b[B")
		panel.handleInput(" ")
		panel.handleInput(CTRL_S)
		// Any subsequent key clears notices (handleInput resets them)
		panel.handleInput("\x1b[A") // up arrow

		const lines = renderText(panel)
		const hasSaveNotice = lines.some((l) => l.includes("Saved"))
		expect(hasSaveNotice).toBe(false)
	})
})

// ─── return key toggles focusDescription on tool rows ─────────────────────────────────

describe("McpPanel return on tool row", () => {
	it("shows the description block in the render output after pressing return on a tool", () => {
		const { panel } = makePanel()

		// Expand the server
		panel.handleInput("\r")
		// Move cursor to the tool row
		panel.handleInput("\x1b[B")
		// Press return on the tool
		panel.handleInput("\r")

		const lines = renderText(panel)
		// The description header contains “▼ server — toolname”
		const hasDescHeader = lines.some((l) => l.includes("▼") && l.includes("my-server") && l.includes("my_tool"))
		expect(hasDescHeader).toBe(true)
	})

	it("hides the description block on the second return press (toggle off)", () => {
		const { panel } = makePanel()

		panel.handleInput("\r") // expand server
		panel.handleInput("\x1b[B") // move to tool
		panel.handleInput("\r") // open description
		panel.handleInput("\r") // close description

		const lines = renderText(panel)
		const hasDescHeader = lines.some((l) => l.includes("▼") && l.includes("my-server") && l.includes("my_tool"))
		expect(hasDescHeader).toBe(false)
	})

	it("clears the description when the cursor moves to a different tool", () => {
		// Two tools in the same server so we can navigate between them.
		const config: McpConfig = { mcpServers: { "my-server": { command: "npx", args: [] } } }
		const cache: MetadataCache = {
			version: 1,
			servers: {
				"my-server": {
					configHash: "abc",
					tools: [
						{ name: "tool_a", description: "Alpha" },
						{ name: "tool_b", description: "Beta" },
					],
					resources: [],
					cachedAt: Date.now(),
				},
			},
		}
		const { panel } = makePanel({ config, cache })

		panel.handleInput("\r") // expand server
		panel.handleInput("\x1b[B") // move to tool_a
		panel.handleInput("\r") // open description for tool_a
		// Navigate down to tool_b — moving the cursor clears focusDescription
		panel.handleInput("\x1b[B")

		const lines = renderText(panel)
		// Neither description header should be visible
		const hasAnyDescHeader = lines.some((l) => l.includes("▼"))
		expect(hasAnyDescHeader).toBe(false)
	})

	it("does not toggle isDirect when return is pressed on a tool (space still does)", () => {
		const { panel, onSave } = makePanel()

		panel.handleInput("\r") // expand server
		panel.handleInput("\x1b[B") // move to tool
		panel.handleInput("\r") // open description (was: toggle isDirect in old code)
		panel.handleInput("\x13") // ctrl+s

		// No changes because return did not toggle isDirect
		expect(onSave).not.toHaveBeenCalled()
	})
})
