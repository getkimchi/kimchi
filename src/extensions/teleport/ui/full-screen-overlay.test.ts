import type { Component } from "@earendil-works/pi-tui"
import { visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it, vi } from "vitest"
import { FULL_SCREEN_OVERLAY_OPTIONS, FullScreenOverlay } from "./full-screen-overlay.js"

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
})
