import { describe, expect, it } from "vitest"
import { parseFermentCommand } from "./command-parser.js"

describe("parseFermentCommand", () => {
	it("parses empty input as the interactive flow", () => {
		expect(parseFermentCommand("")).toEqual({ type: "interactive" })
		expect(parseFermentCommand("   ")).toEqual({ type: "interactive" })
	})

	it("strips the add subcommand from quoted titles", () => {
		expect(parseFermentCommand('add "Rewrite login"')).toEqual({ type: "add", title: "Rewrite login" })
	})

	it("keeps bare text as add shorthand", () => {
		expect(parseFermentCommand("Rewrite login")).toEqual({ type: "add", title: "Rewrite login" })
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
		expect(parseFermentCommand('resume "Rewrite login" --force')).toEqual({
			type: "switch",
			verb: "resume",
			target: "Rewrite login",
			force: true,
		})
	})

	it("parses one-shot intent", () => {
		expect(parseFermentCommand('one-shot "Fix failing tests"')).toEqual({
			type: "one-shot",
			intent: "Fix failing tests",
		})
	})
})
