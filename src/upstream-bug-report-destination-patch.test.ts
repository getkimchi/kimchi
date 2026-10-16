/**
 * Contract test for the /bug destination hunks in
 * `patches/@earendil-works__pi-coding-agent@1.3.0.patch`: kimchi branding and
 * the __kimchiBugReportScrub/__kimchiBugReportDeliver seams.
 *
 * The disclaimer must be selected LAZILY (at dialog-render time): the kimchi
 * destination hook is installed when kimchi's extensions load, which happens
 * after dist/modes/interactive/bug-report.js initializes. An eager
 * module-level choice always picks the Earendil text (the "This report goes
 * to the Pi developers" bug).
 *
 * If this test starts failing after a pin bump, check whether upstream moved
 * the /bug consent flow or added its own destination hook.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

function source(): string {
	return readFileSync(
		new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/bug-report.js", import.meta.url),
		"utf8",
	)
}

describe("patch: /bug kimchi destination seams", () => {
	it("provides the scrub and deliver hook seams", () => {
		const dist = source()
		expect(dist).toContain("globalThis.__kimchiBugReportScrub")
		expect(dist).toContain("globalThis.__kimchiBugReportDeliver")
	})

	it("selects the disclaimer lazily (hook may load after this module)", () => {
		const dist = source()
		expect(dist).toContain("const bugReportDisclaimer = () =>")
		// The consent dialog must call the resolver, not read a module-level
		// const evaluated before extensions loaded.
		expect(dist).toContain("bugReportDisclaimer()")
		// No eager top-level selection should remain.
		expect(dist).not.toMatch(/^const DISCLAIMER =/m)
	})

	it("keeps the Earendil flow intact when no hook is registered", () => {
		const dist = source()
		expect(dist).toContain("This report goes to the Pi developers (Earendil)")
		expect(dist).toContain("kimchiDestinationActive() ? KIMCHI_DISCLAIMER : EARENDIL_DISCLAIMER")
	})

	it("mentions the opt-in private-gist upload in the delivery menu", () => {
		expect(source()).toContain("private GitHub gist")
	})

	it("maps the displayed upload label to an upload delivery (not zip)", () => {
		// Trap: the label becomes "File on GitHub" with the kimchi hook, so a
		// hardcoded "Upload Report" comparison sends GitHub picks to the zip
		// path. The mapping must compare against the displayed label variable.
		expect(source()).toContain('delivery: delivery === uploadLabel ? "upload" : "zip"')
	})
})
