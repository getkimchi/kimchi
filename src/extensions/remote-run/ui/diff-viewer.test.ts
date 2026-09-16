import type { TUI } from "@earendil-works/pi-tui"
import { describe, expect, it, vi } from "vitest"
import type { Theme } from "../../agents/ui/agent-widget.js"
import { DiffViewer } from "./diff-viewer.js"

/** Marker theme: colors render as visible tags so tests assert semantics. */
const theme: Theme = {
	fg: (color, text) => `[${color}]${text}[/${color}]`,
	bold: (text) => `[b]${text}[/b]`,
}

function fakeTui(rows = 14) {
	return {
		terminal: { rows, cols: 80 },
		requestRender: vi.fn(),
	} as unknown as TUI & { requestRender: ReturnType<typeof vi.fn> }
}

function makeViewer(rows = 14) {
	const tui = fakeTui(rows)
	const done = vi.fn()
	const viewer = new DiffViewer(tui, theme, { title: "kimchi/fix-login — 2 files (+9/-2)" }, done)
	return { tui, done, viewer }
}

const SAMPLE_DIFF =
	[
		"diff --git a/src/a.ts b/src/a.ts",
		"index 1111111..2222222 100644",
		"--- a/src/a.ts",
		"+++ b/src/a.ts",
		"@@ -1,3 +1,4 @@",
		" const a = 1",
		"-const b = 2",
		"+const b = 3",
		"+const c = 9",
		"\\ No newline at end of file",
	].join("\n") + "\n"

describe("DiffViewer", () => {
	it("renders additions, deletions, headers and context with diff-aware theme colors", () => {
		const { viewer } = makeViewer(20)
		viewer.appendChunk(SAMPLE_DIFF)
		viewer.finish()

		const out = viewer.render(140).join("\n")

		expect(out).toContain("[b]diff --git a/src/a.ts b/src/a.ts[/b]")
		expect(out).toContain("[muted]--- a/src/a.ts[/muted]")
		expect(out).toContain("[muted]+++ b/src/a.ts[/muted]")
		expect(out).toContain("[b]@@ -1,3 +1,4 @@[/b]")
		expect(out).toContain("[error]-const b = 2[/error]")
		expect(out).toContain("[success]+const b = 3[/success]")
		expect(out).toContain("[muted] const a = 1[/muted]")
		expect(out).toContain("[dim]\\ No newline at end of file[/dim]")
		expect(out).toContain("complete")
	})

	it("buffers partial lines across chunk boundaries", () => {
		const { viewer } = makeViewer()
		viewer.appendChunk("diff --git a/x b/x\n+par")
		viewer.appendChunk("tial line\n+next\n")

		const out = viewer.render(80).join("\n")

		expect(out).toContain("[success]+partial line[/success]")
		expect(out).toContain("[success]+next[/success]")
		expect(viewer.lineCount).toBe(3)
	})

	it("flushes the unterminated tail on finish()", () => {
		const { viewer } = makeViewer()
		viewer.appendChunk("+tail without newline")
		expect(viewer.lineCount).toBe(0)

		viewer.finish()

		expect(viewer.lineCount).toBe(1)
		expect(viewer.render(80).join("\n")).toContain("[success]+tail without newline[/success]")
	})

	it("auto-scrolls to the tail while chunks arrive, then lets j/k take over", () => {
		const { viewer } = makeViewer(10) // viewport = rows - 6 = 4
		const many = Array.from({ length: 30 }, (_, i) => `+line-${i}`).join("\n") + "\n"
		viewer.appendChunk(many)

		let out = viewer.render(80).join("\n")
		// Tail is visible, head is not.
		expect(out).toContain("+line-29")
		expect(out).not.toContain("+line-0")

		// Scroll up — head becomes reachable and auto-scroll disengages.
		for (let i = 0; i < 30; i++) viewer.handleInput("k")
		out = viewer.render(80).join("\n")
		expect(out).toContain("+line-0")
		expect(out).not.toContain("+line-29")
	})

	it("requests a render for every pushed chunk (streamed arrival is visible live)", () => {
		const { tui, viewer } = makeViewer()
		viewer.appendChunk("diff --git a/x b/x\n")
		viewer.appendChunk("+one\n")
		viewer.finish()

		expect(tui.requestRender).toHaveBeenCalledTimes(3)
	})

	it("Esc and q close exactly once via the done callback", () => {
		const { done, viewer } = makeViewer()
		viewer.handleInput("q")
		expect(done).toHaveBeenCalledTimes(1)

		// Subsequent input is ignored — the overlay is closed.
		viewer.handleInput("q")
		viewer.handleInput("\x1b")
		expect(done).toHaveBeenCalledTimes(1)
	})

	it("shows the waiting placeholder before the first chunk", () => {
		const { viewer } = makeViewer()
		const out = viewer.render(140).join("\n")
		expect(out).toContain("(waiting for patch…)")
		expect(out).toContain("streaming…")
	})
})
