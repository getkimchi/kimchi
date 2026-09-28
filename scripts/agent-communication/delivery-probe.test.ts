import { describe, expect, it } from "vitest"
import { shouldPublish } from "./delivery-probe.js"

describe("delivery diagnostic timing", () => {
	it("keeps delayed evidence out until an edit and never injects it into controls", () => {
		for (const edited of [false, true]) {
			expect(shouldPublish("artifacts", edited)).toBe(false)
			expect(shouldPublish("checkpoint", edited)).toBe(false)
			expect(shouldPublish("early", edited)).toBe(true)
			expect(shouldPublish("board", edited)).toBe(true)
		}
		expect(shouldPublish("delayed", false)).toBe(false)
		expect(shouldPublish("delayed", true)).toBe(true)
	})
})
