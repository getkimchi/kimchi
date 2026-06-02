import type { Component } from "@earendil-works/pi-tui"
import { visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it, vi } from "vitest"
import { FULL_SCREEN_OVERLAY_OPTIONS, FullScreenOverlay } from "./full-screen-overlay.js"
import { WorkspacesPanel } from "./workspaces-panel.js"
import type { WorkspaceRow } from "./workspaces-table.js"

interface FakeTui {
	requestRender(force?: boolean): void
	terminal: { rows: number; cols: number }
}

function makeTui(rows: number, cols = 100): FakeTui {
	return { requestRender: vi.fn(), terminal: { rows, cols } }
}

function makeInner(lines: string[], onInput?: (data: string) => void, onInvalidate?: () => void): Component {
	return {
		render: (_width: number) => lines,
		handleInput: onInput,
		invalidate: onInvalidate ?? (() => {}),
	}
}

describe("FullScreenOverlay", () => {
	it("returns exactly termRows lines, each exactly width wide", () => {
		const tui = makeTui(20)
		const overlay = new FullScreenOverlay(makeInner(["a", "b", "c"]), tui)
		const out = overlay.render(50)
		expect(out).toHaveLength(20)
		for (const line of out) expect(visibleWidth(line)).toBe(50)
	})

	it("centers the inner panel horizontally with default 70% width", () => {
		const tui = makeTui(10)
		const inner = makeInner(["X"], undefined)
		const overlay = new FullScreenOverlay(inner, tui)
		const out = overlay.render(100)
		// innerW = 70, leftPad = floor((100-70)/2) = 15, the inner "X" sits at column 15
		const panelRow = out.find((l) => l.includes("X"))
		expect(panelRow).toBeDefined()
		// First 15 columns are spaces, then "X", then 70-1=69 trailing-inner spaces + 15 right pad
		expect(panelRow?.slice(0, 15)).toBe(" ".repeat(15))
		expect(panelRow?.[15]).toBe("X")
		expect(visibleWidth(panelRow ?? "")).toBe(100)
	})

	it("centers the inner panel vertically", () => {
		const tui = makeTui(10)
		const overlay = new FullScreenOverlay(makeInner(["AAA", "BBB"]), tui)
		const out = overlay.render(50)
		// panelH=2 → topPad = floor((10-2)/2) = 4. Rows 4 and 5 hold the panel.
		expect(out[0].trim()).toBe("")
		expect(out[3].trim()).toBe("")
		expect(out[4].trim()).toBe("AAA")
		expect(out[5].trim()).toBe("BBB")
		expect(out[6].trim()).toBe("")
		expect(out[9].trim()).toBe("")
	})

	it("forwards handleInput to the inner panel", () => {
		const tui = makeTui(10)
		const onInput = vi.fn()
		const overlay = new FullScreenOverlay(makeInner(["x"], onInput), tui)
		overlay.handleInput("a")
		expect(onInput).toHaveBeenCalledWith("a")
	})

	it("forwards invalidate and dispose to the inner panel", () => {
		const tui = makeTui(10)
		const onInvalidate = vi.fn()
		const dispose = vi.fn()
		const inner: Component & { dispose(): void } = {
			render: () => ["x"],
			invalidate: onInvalidate,
			dispose,
		}
		const overlay = new FullScreenOverlay(inner, tui)
		overlay.invalidate()
		overlay.dispose()
		expect(onInvalidate).toHaveBeenCalledOnce()
		expect(dispose).toHaveBeenCalledOnce()
	})

	it("clamps padding to 0 when inner height exceeds termRows", () => {
		const tui = makeTui(3)
		const overlay = new FullScreenOverlay(makeInner(["a", "b", "c", "d", "e"]), tui)
		const out = overlay.render(20)
		// panelH=5, topPad=floor((3-5)/2)=floor(-1)=-1→clamped to 0, usedRows=5, bottomPad=0
		// We emit all 5 inner rows; pi-tui clips via maxHeight.
		expect(out).toHaveLength(5)
		for (const line of out) expect(visibleWidth(line)).toBe(20)
	})

	it("supports custom widthPercent", () => {
		const tui = makeTui(10)
		const overlay = new FullScreenOverlay(makeInner(["X"]), tui, { widthPercent: 50 })
		const out = overlay.render(100)
		const panelRow = out.find((l) => l.includes("X"))
		// innerW = 50, leftPad = floor((100-50)/2) = 25
		expect(panelRow?.slice(0, 25)).toBe(" ".repeat(25))
		expect(panelRow?.[25]).toBe("X")
	})

	it("FULL_SCREEN_OVERLAY_OPTIONS exposes the expected pi-tui overlay shape", () => {
		expect(FULL_SCREEN_OVERLAY_OPTIONS).toEqual({
			overlay: true,
			overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
		})
	})

	describe("wraps a real WorkspacesPanel", () => {
		const NOW = new Date("2026-05-17T12:00:00Z")
		const rows: WorkspaceRow[] = [
			{
				id: "03cdc2680000000000",
				name: "kimchi-dev",
				status: "active",
				createdAt: new Date(NOW.getTime() - 27 * 60_000),
				lastActivityAt: new Date(NOW.getTime() - 27 * 60_000),
				host: "successful-round-anteater-486e4e-abbf.remote.kimchi.dev",
				sessionCount: 2,
			},
			{
				id: "619e50070000000000",
				name: "kimchi-dev",
				status: "active",
				createdAt: new Date(NOW.getTime() - 60 * 60_000),
				lastActivityAt: new Date(NOW.getTime() - 60 * 60_000),
				host: "low-unequal-ranger-486e4e-9abc.remote.kimchi.dev",
				sessionCount: 5,
			},
		]

		function firstNonBlankColumn(line: string): number {
			// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping
			const stripped = line.replace(/\x1b\[[0-9;]*m/g, "")
			for (let i = 0; i < stripped.length; i++) {
				if (stripped[i] !== " ") return i
			}
			return -1
		}

		const TERM_WIDTH = 148
		const TERM_ROWS = 30

		it("every emitted line has visibleWidth equal to the terminal width", () => {
			const tui = { requestRender: vi.fn(), terminal: { rows: TERM_ROWS, cols: TERM_WIDTH } }
			const panel = new WorkspacesPanel(rows, tui, vi.fn())
			const overlay = new FullScreenOverlay(panel, tui)
			const out = overlay.render(TERM_WIDTH)
			expect(out).toHaveLength(TERM_ROWS)
			for (const [i, line] of out.entries()) {
				expect(visibleWidth(line), `line ${i} width`).toBe(TERM_WIDTH)
			}
		})

		it("top border, divider, body rows, and bottom border share the same first non-blank column", () => {
			const tui = { requestRender: vi.fn(), terminal: { rows: TERM_ROWS, cols: TERM_WIDTH } }
			const panel = new WorkspacesPanel(rows, tui, vi.fn())
			const overlay = new FullScreenOverlay(panel, tui)
			const out = overlay.render(TERM_WIDTH)
			const indents = out.map(firstNonBlankColumn).filter((c) => c >= 0)
			// Every non-blank row must begin at the same column.
			const distinct = new Set(indents)
			expect(distinct.size, `distinct indents: ${[...distinct].sort().join(",")}`).toBe(1)
		})

		it("alignment is stable across selectedIndex changes (up/down navigation)", () => {
			const tui = { requestRender: vi.fn(), terminal: { rows: TERM_ROWS, cols: TERM_WIDTH } }
			const panel = new WorkspacesPanel(rows, tui, vi.fn())
			const overlay = new FullScreenOverlay(panel, tui)

			const out0 = overlay.render(TERM_WIDTH)
			panel.handleInput("\x1b[B") // down arrow
			const out1 = overlay.render(TERM_WIDTH)

			expect(out0).toHaveLength(out1.length)
			for (let i = 0; i < out0.length; i++) {
				expect(visibleWidth(out0[i]), `out0 line ${i}`).toBe(TERM_WIDTH)
				expect(visibleWidth(out1[i]), `out1 line ${i}`).toBe(TERM_WIDTH)
			}
		})
	})
})
