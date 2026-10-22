import { describe, expect, it } from "vitest"
import { backgroundNotificationsReachUser } from "./background-delivery.js"

describe("backgroundNotificationsReachUser", () => {
	it("is true only for the TUI", () => {
		expect(backgroundNotificationsReachUser("tui")).toBe(true)
	})

	it("is false for rpc (ACP sessions run as rpc)", () => {
		expect(backgroundNotificationsReachUser("rpc")).toBe(false)
	})

	it("is false for json mode", () => {
		expect(backgroundNotificationsReachUser("json")).toBe(false)
	})

	it("is false for print mode", () => {
		expect(backgroundNotificationsReachUser("print")).toBe(false)
	})
})
