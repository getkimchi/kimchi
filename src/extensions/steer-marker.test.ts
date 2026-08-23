import { describe, expect, it } from "vitest"
import {
	isHarnessSteer,
	markHarnessSteer,
	markOrchestratorSteer,
	SYSTEM_REMINDER_CLOSE,
	SYSTEM_REMINDER_OPEN,
} from "./steer-marker.js"

describe("steer-marker", () => {
	describe("markHarnessSteer", () => {
		it("wraps the text in <system-reminder> tags", () => {
			const result = markHarnessSteer("call a tool now")
			expect(result).toBe(`${SYSTEM_REMINDER_OPEN}call a tool now${SYSTEM_REMINDER_CLOSE}`)
		})

		it("does not double-wrap already-marked text", () => {
			const once = markHarnessSteer("call a tool now")
			const twice = markHarnessSteer(once)
			expect(twice).toBe(once)
		})
	})

	describe("markOrchestratorSteer", () => {
		it("wraps the text in <system-reminder> tags", () => {
			const result = markOrchestratorSteer("turn budget warning")
			expect(result).toBe(`${SYSTEM_REMINDER_OPEN}turn budget warning${SYSTEM_REMINDER_CLOSE}`)
		})

		it("does not double-wrap already-marked text", () => {
			const once = markOrchestratorSteer("turn budget warning")
			const twice = markOrchestratorSteer(once)
			expect(twice).toBe(once)
		})
	})

	describe("isHarnessSteer", () => {
		it("returns true for harness-wrapped text", () => {
			expect(isHarnessSteer(markHarnessSteer("x"))).toBe(true)
		})

		it("returns true for orchestrator-wrapped text", () => {
			expect(isHarnessSteer(markOrchestratorSteer("x"))).toBe(true)
		})

		it("returns false for plain user text", () => {
			expect(isHarnessSteer("call a tool now")).toBe(false)
		})

		it("returns false for text that merely mentions the tag", () => {
			expect(isHarnessSteer("<system-reminder> x")).toBe(false)
			expect(isHarnessSteer("see <system-reminder> above")).toBe(false)
		})

		it("returns false when the opening tag is present but the closing tag is missing", () => {
			expect(isHarnessSteer(`${SYSTEM_REMINDER_OPEN}x`)).toBe(false)
		})
	})
})
