import { describe, expect, it } from "vitest"
import {
	type CommandResult,
	type CreateFermentResult,
	type UnknownCommandResult,
	processCommand,
} from "./command-processor.js"

/** Type guard to narrow CommandResult to CreateFermentResult in tests. */
function isCreateFermentResult(result: CommandResult): result is CreateFermentResult {
	return result.isCommand === true && result.command === "create_ferment"
}

/** Type guard to narrow CommandResult to UnknownCommandResult in tests. */
function isUnknownCommandResult(result: CommandResult): result is UnknownCommandResult {
	return result.isCommand === true && result.command !== "create_ferment"
}

describe("processCommand", () => {
	describe("non-command input", () => {
		it("returns unchanged text for input without slash prefix", () => {
			const result = processCommand("Hello world")
			expect(result.isCommand).toBe(false)
			expect(result.promptText).toBe("Hello world")
			expect(result.originalText).toBe("Hello world")
		})

		it("returns unchanged text for empty input", () => {
			const result = processCommand("")
			expect(result.isCommand).toBe(false)
			expect(result.promptText).toBe("")
		})

		it("returns unchanged text for whitespace-only input", () => {
			const result = processCommand("   ")
			expect(result.isCommand).toBe(false)
			expect(result.promptText).toBe("   ")
		})
	})

	describe("create_ferment command", () => {
		it("processes /create_ferment with title argument", () => {
			const result = processCommand("/create_ferment Rewrite authentication")
			expect(isCreateFermentResult(result)).toBe(true)
			if (!isCreateFermentResult(result)) return // TS narrowing
			expect(result.argument).toBe("Rewrite authentication")
			expect(result.title).toBe("Rewrite authentication")
			expect(result.intent).toBe("User wants to create a ferment: Rewrite authentication")
			expect(result.promptText).toContain("request_ferment_workflow")
			expect(result.promptText).toContain('"Rewrite authentication"')
		})

		it("is case-insensitive", () => {
			const lower = processCommand("/create_ferment Title")
			const upper = processCommand("/CREATE_FERMENT Title")
			const mixed = processCommand("/Create_Ferment Title")
			const partial = processCommand("/CREATE_ferment Title")

			for (const r of [lower, upper, mixed, partial]) {
				expect(isCreateFermentResult(r)).toBe(true)
				if (!isCreateFermentResult(r)) continue // TS narrowing
				expect(r.title).toBe("Title")
			}
		})

		it("processes /create_ferment without argument", () => {
			const result = processCommand("/create_ferment")
			expect(isCreateFermentResult(result)).toBe(true)
			if (!isCreateFermentResult(result)) return // TS narrowing
			expect(result.argument).toBe("")
			expect(result.title).toBe("New Ferment")
			expect(result.intent).toBe("User wants to create a new ferment workflow")
			expect(result.promptText).toContain("request_ferment_workflow")
			expect(result.promptText).toContain('"New Ferment"')
		})

		it("processes /create_ferment with multiple word title", () => {
			const result = processCommand("/create_ferment Implement OAuth2 login with Google")
			expect(isCreateFermentResult(result)).toBe(true)
			if (!isCreateFermentResult(result)) return // TS narrowing
			expect(result.title).toBe("Implement OAuth2 login with Google")
			expect(result.argument).toBe("Implement OAuth2 login with Google")
		})

		it("trims leading/trailing whitespace from argument", () => {
			const result = processCommand("/create_ferment   My Ferment   ")
			expect(isCreateFermentResult(result)).toBe(true)
			if (!isCreateFermentResult(result)) return // TS narrowing
			expect(result.title).toBe("My Ferment")
		})

		it("preserves original text unchanged", () => {
			const original = "/create_ferment My Title"
			const result = processCommand(original)
			expect(result.originalText).toBe(original)
		})
	})

	describe("edge cases", () => {
		it("treats bare / as non-command", () => {
			const result = processCommand("/")
			expect(result.isCommand).toBe(false)
			expect(result.promptText).toBe("/")
		})
	})

	describe("unknown commands", () => {
		it("returns unchanged for unknown commands", () => {
			const result = processCommand("/unknown_command something")
			expect(isUnknownCommandResult(result)).toBe(true)
			if (!isUnknownCommandResult(result)) return // TS narrowing
			expect(result.command).toBe("unknown_command")
			expect(result.promptText).toBe("/unknown_command something")
		})

		it("returns unchanged for /pause_ferment (not yet implemented)", () => {
			const result = processCommand("/pause_ferment")
			expect(isUnknownCommandResult(result)).toBe(true)
			if (!isUnknownCommandResult(result)) return // TS narrowing
			expect(result.command).toBe("pause_ferment")
			expect(result.promptText).toBe("/pause_ferment")
		})

		it("returns unchanged for /resume_ferment (not yet implemented)", () => {
			const result = processCommand("/resume_ferment")
			expect(isUnknownCommandResult(result)).toBe(true)
			if (!isUnknownCommandResult(result)) return // TS narrowing
			expect(result.command).toBe("resume_ferment")
			expect(result.promptText).toBe("/resume_ferment")
		})
	})
})
