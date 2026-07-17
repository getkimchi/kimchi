import { describe, expect, it } from "vitest"
import { buildHelpRows } from "./help.js"

describe("help rows", () => {
	it("shows Goal only when the experimental extension loaded", () => {
		expect(buildHelpRows(false)).not.toContainEqual(expect.objectContaining({ key: "/goal" }))
		expect(buildHelpRows(true)).toContainEqual(expect.objectContaining({ key: "/goal" }))
	})
})
