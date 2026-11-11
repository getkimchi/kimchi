/**
 * hasQuotedSelection: the quoted-selection flag for message_sent facts.
 * panel.addQuote prefixes every quoted line with `> ` — only that exact form
 * counts; anything else starting with `>` (shell redirects, REPL prompts,
 * bare markdown quotes) is the user's own typing, not a quoted selection.
 */

import { describe, expect, it } from "vitest"
import { hasQuotedSelection } from "./side-chat-events.js"

describe("hasQuotedSelection", () => {
	it("matches a line quoted by panel.addQuote", () => {
		expect(hasQuotedSelection("> quoted from the transcript\n\nwhat about this?")).toBe(true)
	})

	it("matches a message that is only a quote", () => {
		expect(hasQuotedSelection("> the whole message is a quote")).toBe(true)
	})

	it("matches a quote with an empty quoted line (addQuote of a multi-line selection)", () => {
		expect(hasQuotedSelection("> first line\n> \n> third line")).toBe(true)
	})

	it("does not match shell redirects", () => {
		expect(hasQuotedSelection("command 2>&1 | tee log.txt")).toBe(false)
	})

	it("does not match a bare markdown quote marker without a space", () => {
		expect(hasQuotedSelection(">not a panel quote")).toBe(false)
	})

	it("does not match REPL prompts or comparison operators", () => {
		expect(hasQuotedSelection(">>> import os")).toBe(false)
		expect(hasQuotedSelection("if (a > b) return")).toBe(false)
	})

	it("does not match plain messages", () => {
		expect(hasQuotedSelection("just a question")).toBe(false)
		expect(hasQuotedSelection("")).toBe(false)
	})
})
