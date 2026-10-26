import { describe, expect, it } from "vitest"
import { makeSimplePptx } from "../fixtures/builders.js"
import { extractPptx } from "./pptx.js"

describe("extractPptx", () => {
	it("reads slides in sldIdLst order, not file order", async () => {
		const doc = await extractPptx(await makeSimplePptx())
		expect(doc.format).toBe("pptx")
		expect(doc.units).toHaveLength(3)
		// sldIdLst order: slide1, slide3, slide2
		expect(doc.units[0].markdown).toContain("Kickoff")
		expect(doc.units[1].markdown).toContain("Closing remarks")
		expect(doc.units[2].markdown).toContain("H1") // table slide
	})

	it("marks hidden slides", async () => {
		const doc = await extractPptx(await makeSimplePptx())
		expect(doc.units[2].markdown).toContain("*hidden slide*")
		expect(doc.outline[2]).toContain("(hidden)")
	})

	it("renders shape locators, tables, and notes", async () => {
		const doc = await extractPptx(await makeSimplePptx())
		expect(doc.units[0].markdown).toContain('[shape "Title 1"]')
		expect(doc.units[2].markdown).toContain("[table 1]")
		expect(doc.units[2].markdown).toContain("| H1 | H2 |")
		expect(doc.units[1].markdown).toContain("Notes:")
		expect(doc.units[1].markdown).toContain("Remember to thank sponsors")
	})
})
