import { describe, expect, it } from "vitest"
import { isWorkId, newPlanWorkId } from "./work-id.js"

describe("newPlanWorkId", () => {
	it("takes the ID of the request writing the plan, which the gateway sees in its kimchi-request tag", () => {
		expect(newPlanWorkId("01A1444A-86E4-7A11-8B22-333344445555")).toBe("01a1444a-86e4-7a11-8b22-333344445555")
	})

	it.each([undefined, "test-request"])("mints a fresh UUID without a request ID (%s)", (requestId) => {
		const first = newPlanWorkId(requestId)
		expect(isWorkId(first)).toBe(true)
		expect(newPlanWorkId(requestId)).not.toBe(first)
	})
})
