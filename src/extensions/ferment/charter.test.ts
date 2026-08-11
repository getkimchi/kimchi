import { describe, expect, it } from "vitest"
import type { FermentCharter } from "../../ferment/types.js"
import { CHARTER_COMPACT_MAX_CHARS, renderCharterCompact, renderCharterFull } from "./charter.js"

const baseCharter: FermentCharter = {
	intent: "Recreate the whole macOS Tahoe interface as a web app",
	wowFactor: "It feels indistinguishable from the real desktop",
	confirmedScope: "All default apps interactive; no backend.",
	demoScript: "Boot the page; Finder opens showing files; icons are colorful like the real OS.",
}

describe("renderCharterCompact", () => {
	it("renders intent, wow and demo as indented lines", () => {
		const text = renderCharterCompact(baseCharter)
		expect(text).toContain("Charter:")
		expect(text).toContain("  Intent: Recreate the whole macOS Tahoe interface as a web app")
		expect(text).toContain("  Wow: It feels indistinguishable from the real desktop")
		expect(text).toContain("  Demo: Boot the page;")
		expect(text.length).toBeLessThanOrEqual(CHARTER_COMPACT_MAX_CHARS)
	})

	it("omits absent optional fields without dangling labels", () => {
		const text = renderCharterCompact({ intent: "Fix the login bug" })
		expect(text).toContain("  Intent: Fix the login bug")
		expect(text).not.toContain("Wow:")
		expect(text).not.toContain("Demo:")
	})

	it("squashes multiline fields into one line each", () => {
		const text = renderCharterCompact({
			intent: "Build a\n  multi-line   request\nwith newlines",
		})
		expect(text).toContain("  Intent: Build a multi-line request with newlines")
		expect(text.split("\n")).toHaveLength(2)
	})

	it("drops the demo line first when over budget", () => {
		const long = "x".repeat(CHARTER_COMPACT_MAX_CHARS - 60)
		const text = renderCharterCompact({
			intent: "short",
			wowFactor: long.slice(0, 100),
			demoScript: long,
		})
		expect(text.length).toBeLessThanOrEqual(CHARTER_COMPACT_MAX_CHARS)
		expect(text).toContain("Wow:")
		expect(text).not.toContain("Demo:")
	})

	it("drops the wow line when intent + wow still overflow", () => {
		// "Charter:\n  Intent: short" is 24 chars; the wow line needs 7 + len.
		// len 370 pushes intent+wow to 401 > budget, so wow must drop too.
		const long = "x".repeat(370)
		const text = renderCharterCompact({
			intent: "short",
			wowFactor: long,
			demoScript: long,
		})
		expect(text.length).toBeLessThanOrEqual(CHARTER_COMPACT_MAX_CHARS)
		expect(text).not.toContain("Wow:")
		expect(text).not.toContain("Demo:")
	})

	it("never exceeds the budget even with a pathological intent", () => {
		const text = renderCharterCompact({ intent: "x".repeat(10_000) })
		expect(text.length).toBeLessThanOrEqual(CHARTER_COMPACT_MAX_CHARS)
		expect(text).toContain("truncated")
	})

	it("truncation keeps the marker so readers know more state exists", () => {
		const text = renderCharterCompact({ intent: "x".repeat(10_000) })
		expect(text).toContain("full charter in ferment state")
	})
})

describe("renderCharterFull", () => {
	it("renders every populated field with its label", () => {
		const text = renderCharterFull(baseCharter)
		expect(text).toContain("INTENT CHARTER")
		expect(text).toContain("Intent (the user's original request, verbatim): Recreate the whole macOS Tahoe")
		expect(text).toContain("Wow factor (what would delight, not merely satisfy):")
		expect(text).toContain("Confirmed scope (in / explicitly out):")
		expect(text).toContain("Acceptance demo (beats the final walkthrough must show):")
	})

	it("ends with the directive tying grading to the original intent", () => {
		const text = renderCharterFull(baseCharter)
		expect(text).toContain("Grade against this charter")
		expect(text).toContain("the intent wins")
	})

	it("renders with intent only", () => {
		const text = renderCharterFull({ intent: "Fix the login bug" })
		expect(text).toContain("Intent (the user's original request, verbatim): Fix the login bug")
		expect(text).not.toContain("Wow factor")
	})
})
