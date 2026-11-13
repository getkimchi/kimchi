import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it } from "vitest"
import { testTheme } from "../__mocks__/theme.js"
import type { PRMonitorState } from "./types.js"
import { renderPRWatchWidget } from "./widget.js"

const state: PRMonitorState = {
	revision: 1,
	enabled: true,
	autoFix: false,
	phase: "watching",
	pullRequest: null,
	checkedAt: null,
	message: null,
}
const view = (next: PRMonitorState) => renderPRWatchWidget(next, 150, testTheme).map(stripTerminalSequences).join("\n")

describe("PR tracking indicator", () => {
	it("remains visible during PR discovery and links to the monitor", () => {
		expect(view(state)).toContain("PR watch: watching")
		expect(view(state)).toContain("discovering PR")
		expect(view(state)).toContain("Watch only")
		expect(view(state)).toContain("/pr-watch monitor")
	})
	it("clears when monitoring is stopped", () => {
		expect(renderPRWatchWidget({ ...state, enabled: false }, 100, testTheme)).toEqual([])
	})
	it("keeps unknown and unavailable CI distinct from a healthy result", () => {
		const next: PRMonitorState = {
			...state,
			pullRequest: {
				provider: "github",
				repository: "owner/repo",
				number: 7,
				title: "Fix",
				url: "https://github.com/owner/repo/pull/7",
				branch: "feature",
				headSha: "a",
				state: "open",
				checks: [],
				feedback: [],
			},
		}
		expect(view(next)).toContain("CI unknown")
		expect(view({ ...next, phase: "error" })).toContain("CI unavailable")
		expect(view({ ...next, phase: "error" })).not.toContain("0 CI failing")
	})
	it("fits narrow terminals with ANSI styling", () => {
		for (const width of [1, 2, 20, 40, 90, 150]) {
			const lines = renderPRWatchWidget(state, width, testTheme)
			expect(lines).toHaveLength(1)
			expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width)
		}
	})
})
