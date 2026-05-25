import { describe, expect, it } from "vitest"
import { parseFermentCommand } from "./command-parser.js"

describe("parseFermentCommand", () => {
	it("parses empty input as the interactive flow", () => {
		expect(parseFermentCommand("")).toEqual({ type: "interactive" })
		expect(parseFermentCommand("   ")).toEqual({ type: "interactive" })
	})

	it("strips the new subcommand from quoted titles", () => {
		expect(parseFermentCommand('new "Rewrite login"')).toEqual({ type: "new", title: "Rewrite login" })
	})

	it("treats bare text as an unknown command", () => {
		expect(parseFermentCommand("Rewrite login")).toEqual({ type: "unknown", input: "Rewrite login" })
	})

	it("does not accept the old add alias", () => {
		expect(parseFermentCommand('add "Rewrite login"')).toEqual({ type: "unknown", input: 'add "Rewrite login"' })
	})

	it("does not accept the old mode command", () => {
		expect(parseFermentCommand("mode exec")).toEqual({ type: "unknown", input: "mode exec" })
	})

	it("parses switch force before the target", () => {
		expect(parseFermentCommand('switch --force "Rewrite login"')).toEqual({
			type: "switch",
			verb: "switch",
			target: "Rewrite login",
			force: true,
		})
	})

	it("parses switch force after the target", () => {
		expect(parseFermentCommand('switch "Rewrite login" --force')).toEqual({
			type: "switch",
			verb: "switch",
			target: "Rewrite login",
			force: true,
		})
	})

	it("does not treat resume with a target as switch shorthand", () => {
		expect(parseFermentCommand('resume "Rewrite login" --force')).toEqual({
			type: "unknown",
			input: 'resume "Rewrite login" --force',
		})
	})

	it("does not treat use as switch shorthand", () => {
		expect(parseFermentCommand('use "Rewrite login"')).toEqual({ type: "unknown", input: 'use "Rewrite login"' })
	})

	it("parses bare pause as active ferment lifecycle pause", () => {
		expect(parseFermentCommand("pause")).toEqual({ type: "pause-lifecycle" })
	})

	it("parses bare resume as active ferment lifecycle resume", () => {
		expect(parseFermentCommand("resume")).toEqual({ type: "resume-lifecycle" })
	})

	it("parses bare exit as Ferment mode exit", () => {
		expect(parseFermentCommand("exit")).toEqual({ type: "exit" })
	})

	it("parses nested continuation policy commands", () => {
		expect(parseFermentCommand("manual")).toEqual({ type: "manual-policy" })
		expect(parseFermentCommand("auto")).toEqual({ type: "auto-policy" })
	})

	it("parses nested progress command", () => {
		expect(parseFermentCommand("progress")).toEqual({ type: "progress" })
	})

	it("parses one-shot intent", () => {
		expect(parseFermentCommand('one-shot "Fix failing tests"')).toEqual({
			type: "one-shot",
			intent: "Fix failing tests",
		})
	})
})
