import {
	CURSOR_MARKER,
	ProcessTerminal,
	stripTerminalSequences,
	TuiAltScreen,
	visibleWidth,
} from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { testTheme } from "../__mocks__/theme.js"
import { isRawInputCaptureActive } from "../shared-input.js"
import { PRMonitor } from "./monitor.js"
import { PRMonitorPanel } from "./panel.js"
import { readPRSnapshot } from "./providers.js"
import type { PRSnapshot } from "./types.js"

vi.mock("./providers.js", () => ({ readPRSnapshot: vi.fn() }))

const pr = (): PRSnapshot => ({
	provider: "github",
	repository: "owner/repo",
	number: 7,
	title: "Parser fix",
	url: "https://github.com/owner/repo/pull/7",
	branch: "fix/parser",
	headSha: "a".repeat(40),
	state: "open",
	checks: [{ id: "tests", name: "Tests", state: "failed", summary: "Failed", url: null }],
	feedback: [],
})

describe("PR Monitor panel", () => {
	let monitor: PRMonitor
	let panel: PRMonitorPanel
	let ctx: ReturnType<typeof createContext>
	let extension: ReturnType<typeof createExtensionApi>
	const tui = { requestRender: vi.fn(), terminal: { rows: 45 } }
	const view = () => panel.render(110).map(stripTerminalSequences).join("\n")
	beforeEach(async () => {
		vi.useFakeTimers()
		vi.mocked(readPRSnapshot).mockResolvedValue(pr())
		extension = createExtensionApi()
		ctx = createContext({ isIdle: vi.fn(() => false), isProjectTrusted: vi.fn(() => true), abort: vi.fn() })
		monitor = new PRMonitor(extension.api, ctx)
		await monitor.configure(true, false)
		tui.terminal.rows = 45
		tui.requestRender.mockClear()
	})
	afterEach(async () => {
		panel?.dispose()
		await monitor.dispose()
		vi.useRealTimers()
	})
	it("opens a single Monitor tab and closes without polling, changing consent or aborting", async () => {
		const refresh = vi.spyOn(monitor, "refresh")
		const configure = vi.spyOn(monitor, "configure")
		const done = vi.fn()
		panel = new PRMonitorPanel(monitor, tui, done, testTheme)
		expect(view()).toContain("[Monitor]")
		expect(view()).toContain("failed: Tests")
		expect(view()).not.toMatch(/\[Script\]|\[Output\]/)
		expect(isRawInputCaptureActive()).toBe(true)
		panel.handleInput("\x03")
		expect(done).toHaveBeenCalledOnce()
		expect(isRawInputCaptureActive()).toBe(false)
		expect(refresh).not.toHaveBeenCalled()
		expect(configure).not.toHaveBeenCalled()
		expect(ctx.abort).not.toHaveBeenCalled()
		expect(monitor.snapshot).toMatchObject({ enabled: true, autoFix: false })
		expect(extension.sendMessage).not.toHaveBeenCalled()
		tui.requestRender.mockClear()
		await vi.advanceTimersByTimeAsync(1000)
		expect(tui.requestRender).not.toHaveBeenCalled()
	})
	it("updates an open view from monitor observations", async () => {
		panel = new PRMonitorPanel(monitor, tui, vi.fn(), testTheme)
		const next = pr()
		next.checks[0].state = "passed"
		next.feedback = [
			{
				id: "r",
				author: "outsider",
				body: "Please add a test",
				path: "parser.ts",
				line: 8,
				url: next.url,
				trusted: false,
			},
		]
		vi.mocked(readPRSnapshot).mockResolvedValue(next)
		await monitor.refresh()
		expect(view()).toContain("passed: Tests")
		expect(view()).toContain("manual review")
		expect(view()).toContain("Please add a test")
		expect(tui.requestRender).toHaveBeenCalled()
		expect(extension.sendMessage).not.toHaveBeenCalled()
	})
	it("offers explicit refresh, pause and stop without granting fixes", async () => {
		await monitor.configure(true, true)
		panel = new PRMonitorPanel(monitor, tui, vi.fn(), testTheme)
		expect(view()).toContain("P pause fixes")
		panel.handleInput("p")
		await vi.advanceTimersByTimeAsync(0)
		expect(monitor.snapshot).toMatchObject({ enabled: true, autoFix: false })
		expect(view()).not.toContain("P pause fixes")
		const refresh = vi.spyOn(monitor, "refresh")
		panel.handleInput("r")
		await vi.advanceTimersByTimeAsync(0)
		expect(refresh).toHaveBeenCalledOnce()
		panel.handleInput("s")
		await vi.advanceTimersByTimeAsync(0)
		expect(monitor.snapshot).toMatchObject({ enabled: false, autoFix: false })
		expect(view()).toContain("stopped")
		expect(view()).not.toContain("S stop")
		expect(extension.sendMessage).not.toHaveBeenCalled()
	})
	it("detaches while a refresh is pending and never redraws a disposed panel", async () => {
		let finish!: () => void
		vi.spyOn(monitor, "refresh").mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = () => resolve(monitor.snapshot)
				}),
		)
		panel = new PRMonitorPanel(monitor, tui, vi.fn(), testTheme)
		panel.handleInput("r")
		panel.handleInput("r")
		expect(monitor.refresh).toHaveBeenCalledOnce()
		panel.close()
		tui.requestRender.mockClear()
		finish()
		await vi.advanceTimersByTimeAsync(1000)
		expect(tui.requestRender).not.toHaveBeenCalled()
	})
	it("keeps errors separate from the last known check results", async () => {
		panel = new PRMonitorPanel(monitor, tui, vi.fn(), testTheme)
		vi.mocked(readPRSnapshot).mockRejectedValue(new Error("GitHub unavailable"))
		panel.handleInput("r")
		await vi.advanceTimersByTimeAsync(0)
		expect(view()).toContain("GitHub unavailable")
		expect(view()).toContain("CI (last known)")
	})
	it("scrolls long checks and reviews while keeping the Monitor tab and controls pinned", async () => {
		const snapshot = pr()
		snapshot.checks = Array.from({ length: 30 }, (_, i) => ({
			id: String(i),
			name: `check-${i}`,
			state: "passed",
			summary: "",
			url: null,
		}))
		snapshot.feedback = [
			{
				id: "r",
				author: "reviewer",
				body: "last review body",
				path: null,
				line: null,
				url: snapshot.url,
				trusted: true,
			},
		]
		vi.mocked(readPRSnapshot).mockResolvedValue(snapshot)
		await monitor.refresh()
		panel = new PRMonitorPanel(monitor, tui, vi.fn(), testTheme)
		panel.handleInput("\x1b[F")
		expect(view()).toContain("last review body")
		expect(view()).toContain("[Monitor]")
		expect(view()).toContain("Esc close")
		tui.terminal.rows = 24
		panel.handleInput("\x1b[H")
		expect(view()).toContain("Parser fix")
	})
	it("renders safe provider text and fits narrow resizes", async () => {
		const snapshot = pr()
		snapshot.title = "字\x1b]52;c;secret\x07\x1b[31m malicious\u202e\0"
		vi.mocked(readPRSnapshot).mockResolvedValue(snapshot)
		await monitor.refresh()
		panel = new PRMonitorPanel(monitor, tui, vi.fn(), testTheme)
		for (const width of [1, 2, 7, 20, 100])
			for (const rows of [3, 10, 24, 45]) {
				tui.terminal.rows = rows
				const lines = panel.render(width)
				expect(lines.length).toBeLessThanOrEqual(Math.max(1, rows - 2))
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width)
					expect(stripTerminalSequences(line)).not.toMatch(/[\p{Cc}\u202e]/u)
					expect(line).not.toContain("secret")
				}
			}
	})
	it("does not insert the main-screen cursor marker into a fullscreen view", () => {
		const fullscreen = new TuiAltScreen(new ProcessTerminal())
		vi.spyOn(fullscreen, "requestRender").mockImplementation(() => {})
		panel = new PRMonitorPanel(monitor, fullscreen, vi.fn(), testTheme)
		expect(panel.render(100).join("\n")).not.toContain(CURSOR_MARKER)
	})
	it("keeps the close hint visible with all actions at narrow widths", async () => {
		await monitor.configure(true, true)
		panel = new PRMonitorPanel(monitor, tui, vi.fn(), testTheme)
		for (const width of [20, 40, 60, 100]) {
			expect(panel.render(width).map(stripTerminalSequences).join("\n")).toContain("Esc close")
		}
	})
})
