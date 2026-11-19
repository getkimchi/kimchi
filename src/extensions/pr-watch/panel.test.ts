import {
	CURSOR_MARKER,
	ProcessTerminal,
	stripTerminalSequences,
	TuiAltScreen,
	visibleWidth,
} from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { testTheme } from "../__mocks__/theme.js"
import { PRWatchPanel } from "./panel.js"
import type { PRCheck, PRWatchState, TargetState } from "./types.js"

const target = (number: number, checks: PRCheck[], overrides: Partial<TargetState> = {}): TargetState => ({
	url: `https://github.com/owner/repo/pull/${number}`,
	cwd: `/checkouts/${number}`,
	enabled: true,
	autoFix: true,
	mode: "ci",
	instructions: "",
	attempts: 0,
	handled: [],
	phase: "watching",
	checkedAt: new Date().toISOString(),
	message: null,
	pullRequest: {
		provider: "github",
		repository: "owner/repo",
		number,
		title: "Parser fix",
		url: `https://github.com/owner/repo/pull/${number}`,
		branch: "fix",
		headSha: "a".repeat(40),
		state: "open",
		checks,
		feedback: [],
	},
	...overrides,
})
const check = (name: string, state: PRCheck["state"]): PRCheck => ({ id: name, name, state, url: null, summary: "" })

describe("PR watch Monitor", () => {
	let state: PRWatchState
	let publish: (next: PRWatchState) => void
	let panel: PRWatchPanel
	const tui = { requestRender: vi.fn(), terminal: { rows: 45 } }
	const watcher = {
		get snapshot() {
			return state
		},
		observe: vi.fn((listener: (next: PRWatchState) => void) => {
			publish = listener
			return () => {}
		}),
		refresh: vi.fn(async () => state),
		pause: vi.fn(() => state),
		stop: vi.fn(() => state),
	}
	const view = (width = 110) => panel.render(width).map(stripTerminalSequences).join("\n")
	beforeEach(() => {
		vi.clearAllMocks()
		tui.terminal.rows = 45
		state = { targets: [target(7, [check("Tests", "failed"), check("Lint", "passed")])], message: null }
	})
	afterEach(() => panel?.dispose())

	it("shows each watched PR's failing and running checks and its feedback", () => {
		state.targets.push(
			target(8, [check("Build", "pending")], { autoFix: false, message: "Commit or stash local changes" }),
		)
		state.targets[0].pullRequest?.feedback.push({
			id: "r",
			author: "reviewer",
			body: "Rename\nthis   variable",
			path: "src/a.ts",
			line: 3,
			url: "https://github.com/owner/repo/pull/7#r",
			trusted: false,
		})
		panel = new PRWatchPanel(watcher, tui, vi.fn(), testTheme)
		const text = view()
		expect(text).toContain("Monitor · 2 PRs")
		expect(text).toContain("owner/repo PR #7 · Watching · Auto-fix on · CI only")
		expect(text).toContain("failed: Tests")
		expect(text).toContain("reviewer · src/a.ts:3 · manual review")
		expect(text).toContain("Rename this variable")
		expect(text).toContain("owner/repo PR #8 · Watching · Watch only")
		expect(text).toContain("pending: Build")
		expect(text).toContain("Commit or stash local changes")
		expect(text).not.toContain("Lint")
	})

	it("refreshes, pauses and stops on R, P and S, and closes on Esc", () => {
		const done = vi.fn()
		panel = new PRWatchPanel(watcher, tui, done, testTheme)
		for (const key of ["r", "p", "s"]) panel.handleInput(key)
		expect(watcher.refresh).toHaveBeenCalledOnce()
		panel.handleInput("\x1b")
		expect(done).toHaveBeenCalledOnce()
		expect(watcher.pause).not.toHaveBeenCalled()
		panel = new PRWatchPanel(watcher, tui, vi.fn(), testTheme)
		panel.handleInput("p")
		expect(watcher.pause).toHaveBeenCalledOnce()
	})

	it("redraws when the watcher publishes", () => {
		panel = new PRWatchPanel(watcher, tui, vi.fn(), testTheme)
		publish({
			targets: [target(7, [check("Tests", "failed")], { phase: "error", message: "GitHub unavailable" })],
			message: null,
		})
		expect(tui.requestRender).toHaveBeenCalled()
		expect(view()).toContain("GitHub unavailable")
		expect(view()).toContain("CI (last known): 1 failed")
	})

	it("scrolls long content and keeps the heading and controls pinned", () => {
		state = {
			targets: [
				target(
					7,
					Array.from({ length: 30 }, (_, i) => check(`check-${i}`, "pending")),
				),
			],
			message: null,
		}
		panel = new PRWatchPanel(watcher, tui, vi.fn(), testTheme)
		expect(view()).not.toContain("check-29")
		panel.handleInput("\x1b[F")
		expect(view()).toContain("check-29")
		expect(view()).toContain("Monitor · PR #7")
		expect(view()).toContain("Esc close")
		tui.terminal.rows = 8
		expect(view(80).trimEnd()).toBe("Esc close · enlarge terminal to monitor")
	})

	it("strips terminal controls from provider text and fits every size", () => {
		state.targets[0].pullRequest?.checks.push(check("字\x1b]52;c;secret\x07\x1b[31m bad‮\0", "failed"))
		panel = new PRWatchPanel(watcher, tui, vi.fn(), testTheme)
		for (const width of [1, 2, 7, 20, 100])
			for (const rows of [3, 10, 24, 45]) {
				tui.terminal.rows = rows
				for (const line of panel.render(width)) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width)
					expect(stripTerminalSequences(line)).not.toMatch(/[\p{Cc}‮]/u)
					expect(line).not.toContain("secret")
				}
			}
	})

	it("adds no main-screen cursor marker to a fullscreen view", () => {
		const fullscreen = new TuiAltScreen(new ProcessTerminal())
		vi.spyOn(fullscreen, "requestRender").mockImplementation(() => {})
		panel = new PRWatchPanel(watcher, fullscreen, vi.fn(), testTheme)
		expect(panel.render(100).join("\n")).not.toContain(CURSOR_MARKER)
	})
})
