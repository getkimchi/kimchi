import { describe, expect, it } from "vitest"
import { isWorkId, newPlanWorkId } from "./work-id.js"

describe("newPlanWorkId", () => {
	it("takes the ID of the session writing the plan, which the gateway sees as X-Session-Id", () => {
		expect(newPlanWorkId("01A1444A-86E4-7A11-8B22-333344445555")).toBe("01a1444a-86e4-7a11-8b22-333344445555")
	})

	it("mints a fresh UUID when the session ID is not one", () => {
		const first = newPlanWorkId("test-session")
		expect(isWorkId(first)).toBe(true)
		expect(newPlanWorkId("test-session")).not.toBe(first)
	})
})
