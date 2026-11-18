import { describe, expect, it } from "vitest"
import { backgroundHandoffHandleFromDetails, isBashBackgroundSettleData } from "./bash-background-settle.js"

describe("isBashBackgroundSettleData", () => {
	it("accepts a full persisted settle payload", () => {
		expect(
			isBashBackgroundSettleData({
				toolCallId: "call-1",
				isError: false,
				text: "output",
				details: { handle: "h-1", exited: true, exitCode: 0 },
			}),
		).toBe(true)
	})

	it("accepts an empty-text terminal settle", () => {
		expect(
			isBashBackgroundSettleData({
				toolCallId: "call-1",
				isError: true,
				text: "",
				details: { handle: "h-1", exited: true, exitCode: null, reason: "harness restarted" },
			}),
		).toBe(true)
	})

	it("rejects non-object payloads", () => {
		expect(isBashBackgroundSettleData(undefined)).toBe(false)
		expect(isBashBackgroundSettleData(null)).toBe(false)
		expect(isBashBackgroundSettleData("bash-background-settle")).toBe(false)
		expect(isBashBackgroundSettleData(42)).toBe(false)
	})

	it("rejects partial settles missing the outcome fields", () => {
		expect(isBashBackgroundSettleData({ toolCallId: "call-1" })).toBe(false)
		expect(isBashBackgroundSettleData({ toolCallId: "call-1", isError: true })).toBe(false)
		expect(isBashBackgroundSettleData({ toolCallId: "call-1", text: "" })).toBe(false)
	})

	it("rejects wrongly typed fields", () => {
		expect(isBashBackgroundSettleData({ toolCallId: 1, isError: false, text: "" })).toBe(false)
		expect(isBashBackgroundSettleData({ toolCallId: "call-1", isError: "no", text: "" })).toBe(false)
		expect(isBashBackgroundSettleData({ toolCallId: "call-1", isError: false, text: null })).toBe(false)
	})
})

describe("backgroundHandoffHandleFromDetails", () => {
	it("returns the handle of a live handoff payload", () => {
		expect(backgroundHandoffHandleFromDetails({ handoff: true, handle: "h-1", exited: false })).toBe("h-1")
	})

	it("ignores terminal results that were never handoffs", () => {
		expect(backgroundHandoffHandleFromDetails({ exited: true, exitCode: 0 })).toBeUndefined()
		expect(backgroundHandoffHandleFromDetails({ handoff: false, handle: "h-2" })).toBeUndefined()
		expect(backgroundHandoffHandleFromDetails({})).toBeUndefined()
	})

	it("ignores non-object and non-handoff shapes at the trust boundary", () => {
		expect(backgroundHandoffHandleFromDetails(undefined)).toBeUndefined()
		expect(backgroundHandoffHandleFromDetails(null)).toBeUndefined()
		expect(backgroundHandoffHandleFromDetails("h-1")).toBeUndefined()
		expect(backgroundHandoffHandleFromDetails(["handoff", true])).toBeUndefined()
	})

	it("requires a non-empty string handle", () => {
		expect(backgroundHandoffHandleFromDetails({ handoff: true, handle: "" })).toBeUndefined()
		expect(backgroundHandoffHandleFromDetails({ handoff: true, handle: 7 })).toBeUndefined()
		expect(backgroundHandoffHandleFromDetails({ handoff: true })).toBeUndefined()
	})
})
