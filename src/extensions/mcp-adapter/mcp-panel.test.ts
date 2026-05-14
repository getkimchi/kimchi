import { describe, expect, it } from "vitest"
import { computeVisibleWindow } from "./mcp-panel.js"

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
