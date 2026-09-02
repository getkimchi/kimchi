import { describe, expect, it } from "vitest"

import { SLASH_COMMANDS } from "../../extensions/slash-commands.js"
import { AVAILABLE_COMMANDS } from "./commands.js"

describe("AVAILABLE_COMMANDS — ACP advertisement", () => {
	it("exposes at least one command", () => {
		expect(AVAILABLE_COMMANDS.length).toBeGreaterThan(0)
	})

	it("includes the /bug command advertised from SLASH_COMMANDS", () => {
		const bug = AVAILABLE_COMMANDS.find((c) => c.name === "bug")
		expect(bug).toBeDefined()
		expect(bug?.description).toBe(SLASH_COMMANDS.bug.hint)
	})

	it("every advertised name is a real slash command", () => {
		for (const cmd of AVAILABLE_COMMANDS) {
			expect(SLASH_COMMANDS).toHaveProperty(cmd.name)
		}
	})

	it("every advertised description is a non-empty string", () => {
		for (const cmd of AVAILABLE_COMMANDS) {
			expect(typeof cmd.description).toBe("string")
			expect(cmd.description.length).toBeGreaterThan(0)
		}
	})
})
