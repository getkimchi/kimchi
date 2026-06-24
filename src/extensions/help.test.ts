import { describe, expect, it } from "vitest"
import { HELP_ROWS, getHelpCommandKeys } from "./help.js"

describe("HELP_ROWS", () => {
	const commandKeys = getHelpCommandKeys()

	it("lists high-value session and auth commands", () => {
		for (const key of ["/name", "/session", "/resume", "/login"]) {
			expect(commandKeys, key).toContain(key)
		}
	})

	it("lists Kimchi-only commands that were previously missing", () => {
		for (const key of ["/teleport", "/clear", "/mcp-auth", "/thinking-steps", "/hooks", "/plugins", "/todos"]) {
			expect(commandKeys, key).toContain(key)
		}
	})

	it("documents /exit instead of upstream /quit", () => {
		expect(commandKeys).toContain("/exit")
		expect(commandKeys).not.toContain("/quit")
	})

	it("excludes internal Claude Code compat toggles", () => {
		for (const key of ["/cc-tools", "/cc-theme", "/cc-spinner"]) {
			expect(commandKeys, key).not.toContain(key)
		}
	})

	it("uses subsection headings instead of a single Slash Commands block", () => {
		const headings = HELP_ROWS.filter((row) => row.kind === "heading").map((row) => row.text)
		expect(headings).not.toContain("Slash Commands")
		expect(headings).toContain("Session")
		expect(headings).toContain("Teleport")
	})
})
