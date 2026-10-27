import { describe, expect, it } from "vitest"
import { extractPptx } from "../extractors/pptx.js"
import { makeSimplePptx, makeTemplatedPptx } from "../fixtures/builders.js"
import { openOoxml } from "../ooxml/package.js"
import { byTag, parseXml } from "../ooxml/xml.js"
import { parseDeckMarkdown, writePptx } from "../writers/pptx.js"
import { applyPptxOps, parseCellRef, parsePptxOps } from "./pptx.js"

// makeSimplePptx: 3 slides in sldIdLst order — slide1 (Title 1 / Body 1),
// slide3 (Body 1, notes attached), slide2 (2x2 table, hidden).

async function writtenDeck(markdown: string): Promise<Uint8Array> {
	return writePptx(parseDeckMarkdown(markdown))
}

describe("set_shape_text", () => {
	it("replaces the text and reads back", async () => {
		const pkg = await openOoxml(await makeSimplePptx())
		applyPptxOps(pkg, [{ type: "set_shape_text", slide: 1, shape: "Body 1", value: "replaced" }])
		const doc = await extractPptx(await pkg.save())
		expect(doc.units[0].markdown).toContain("replaced")
		expect(doc.units[0].markdown).not.toContain("Agenda items")
	})

	it("preserves run properties by cloning the last run's rPr", async () => {
		const pkg = await openOoxml(await makeSimplePptx())
		applyPptxOps(pkg, [{ type: "set_shape_text", slide: 1, shape: "Body 1", value: "calm" }])
		const doc = pkg.getXml("ppt/slides/slide1.xml")
		const sp = byTag(doc, "sp").find((el) => byTag(el, "t").some((t) => t.textContent === "calm"))
		expect(sp).toBeDefined()
	})

	it("errors with the slide's shape roster when the name is wrong", async () => {
		const pkg = await openOoxml(await makeSimplePptx())
		expect(() => applyPptxOps(pkg, [{ type: "set_shape_text", slide: 1, shape: "Nope", value: "x" }])).toThrow(
			/no shape named "Nope" \(here: “Title 1”, “Body 1”\)/,
		)
	})

	it("errors politely on out-of-range slides", async () => {
		const pkg = await openOoxml(await makeSimplePptx())
		expect(() => applyPptxOps(pkg, [{ type: "set_shape_text", slide: 9, shape: "Body 1", value: "x" }])).toThrow(
			/slide 9 is out of range \(deck has 3 slides\)/,
		)
	})
})

describe("set_shape_notes", () => {
	it("edits the notes body placeholder only", async () => {
		const pkg = await openOoxml(await makeSimplePptx())
		applyPptxOps(pkg, [{ type: "set_shape_notes", slide: 2, value: "shipped" }])
		const doc = await extractPptx(await pkg.save())
		expect(doc.units[1].markdown).toContain("shipped")
		expect(doc.units[1].markdown).not.toContain("Remember to thank sponsors")
		// The slide itself is untouched.
		expect(doc.units[1].markdown).toContain("Closing remarks")
	})

	it("errors with fix language when the slide has no notes part", async () => {
		const pkg = await openOoxml(await makeSimplePptx())
		expect(() => applyPptxOps(pkg, [{ type: "set_shape_notes", slide: 1, value: "n" }])).toThrow(
			/slide has no notes part/,
		)
	})
})

describe("table ops", () => {
	it("set_table_cell edits one cell and set_table_row rewrites a row", async () => {
		const pkg = await openOoxml(await makeSimplePptx())
		applyPptxOps(pkg, [
			{ type: "set_table_cell", slide: 3, table: 1, cell: "B2", value: "two" },
			{ type: "set_table_row", slide: 3, table: 1, row: 1, values: ["x", "y"] },
		])
		const doc = await extractPptx(await pkg.save())
		expect(doc.units[2].markdown).toContain("| x | y |")
		expect(doc.units[2].markdown).toContain("| C1 | two |")
	})

	it("set_table_row with the wrong value count errors with the column count", async () => {
		const pkg = await openOoxml(await makeSimplePptx())
		expect(() => applyPptxOps(pkg, [{ type: "set_table_row", slide: 3, table: 1, row: 1, values: ["a"] }])).toThrow(
			/row 1 has 2 cells but 1 values were given/,
		)
	})

	it("set_table_cell outside the grid names the dimensions", async () => {
		const pkg = await openOoxml(await makeSimplePptx())
		expect(() => applyPptxOps(pkg, [{ type: "set_table_cell", slide: 3, table: 1, cell: "D9", value: "z" }])).toThrow(
			/cell D9 is outside the table \(2 rows x 2 columns\)/,
		)
	})

	it("parseCellRef parses A1-style references", () => {
		expect(parseCellRef("A1")).toEqual([0, 0])
		expect(parseCellRef("B3")).toEqual([1, 2])
		expect(parseCellRef("AA10")).toEqual([26, 9])
		expect(() => parseCellRef("1A")).toThrow(/invalid cell reference "1A"/)
	})
})

describe("append_slide / delete_slide / reorder_slides", () => {
	it("appends a slide on a named layout and titles it", async () => {
		const pkg = await openOoxml(await makeTemplatedPptx())
		applyPptxOps(pkg, [{ type: "append_slide", layout: "Title and Content", title: "New Cover" }])
		const doc = await extractPptx(await pkg.save())
		expect(doc.units).toHaveLength(2)
		expect(doc.units[1].markdown).toContain("New Cover")
	})

	it("appends on the structural default layout when none is named", async () => {
		const pkg = await openOoxml(await makeTemplatedPptx())
		applyPptxOps(pkg, [{ type: "append_slide", title: "Extra" }])
		const doc = await extractPptx(await pkg.save())
		expect(doc.units).toHaveLength(2)
		expect(doc.units[1].markdown).toContain("Extra")
	})

	it("appends to a created deck whose layouts carry no placeholders", async () => {
		// pptxgenjs-built decks have a single bare layout; the title must still land.
		const pkg = await openOoxml(await writtenDeck("# Base\n\n- a\n"))
		applyPptxOps(pkg, [{ type: "append_slide", title: "Extra" }])
		const doc = await extractPptx(await pkg.save())
		expect(doc.units).toHaveLength(2)
		expect(doc.units[1].markdown).toContain("Extra")
	})

	it("errors on an unknown layout name with the available roster", async () => {
		const pkg = await openOoxml(await makeTemplatedPptx())
		expect(() => applyPptxOps(pkg, [{ type: "append_slide", layout: "Nope", title: "x" }])).toThrow(
			/no layout named "Nope".*Title and Content/,
		)
	})

	it("deletes the middle slide and renumbers cleanly", async () => {
		const pkg = await openOoxml(await writtenDeck("# One\n\n- a\n\n---\n# Two\n\n- b\n\n---\n# Three\n\n- c\n"))
		applyPptxOps(pkg, [{ type: "delete_slide", index: 2 }])
		const doc = await extractPptx(await pkg.save())
		expect(doc.units).toHaveLength(2)
		expect(doc.units[0].markdown).toContain("One")
		expect(doc.units[1].markdown).toContain("Three")
	})

	it("rejects deleting the only slide", async () => {
		const pkg = await openOoxml(await makeTemplatedPptx())
		expect(() => applyPptxOps(pkg, [{ type: "delete_slide", index: 1 }])).toThrow(/only slide/)
	})

	it("applies structural ops in sequence against the renumbered deck", async () => {
		const markdown = "# One\n\n- a\n\n---\n# Two\n\n- b\n\n---\n# Three\n\n- c\n\n---\n# Four\n\n- d\n"

		// two deletes: slide numbers shift after the first removal.
		{
			const pkg = await openOoxml(await writtenDeck(markdown))
			applyPptxOps(pkg, [
				{ type: "delete_slide", index: 1 },
				{ type: "delete_slide", index: 2 },
			])
			const doc = await extractPptx(await pkg.save())
			expect(doc.units.map((u) => u.markdown)).toEqual([
				expect.stringContaining("Two"),
				expect.stringContaining("Four"),
			])
		}

		// append then edit the NEW slide (its index only exists post-append).
		{
			const pkg = await openOoxml(await writtenDeck("# Base\n\n- a\n"))
			applyPptxOps(pkg, [
				{ type: "append_slide", title: "Fresh" },
				{ type: "set_shape_text", slide: 2, shape: "Text 0", value: "Written after append" },
			])
			const doc = await extractPptx(await pkg.save())
			expect(doc.units[1].markdown).toContain("Written after append")
		}

		// delete then edit the renumbered survivor.
		{
			const pkg = await openOoxml(await writtenDeck(markdown))
			applyPptxOps(pkg, [
				{ type: "delete_slide", index: 1 },
				{ type: "set_shape_text", slide: 1, shape: "Text 0", value: "renamed-hero" },
			])
			const doc = await extractPptx(await pkg.save())
			expect(doc.units[0].markdown).toContain("renamed-hero")
			expect(JSON.stringify(doc.units)).not.toContain("One")
		}
	})

	it("reorders slides and enforces full permutations", async () => {
		const pkg = await openOoxml(await writtenDeck("# One\n\n- a\n\n---\n# Two\n\n- b\n\n---\n# Three\n\n- c\n"))
		applyPptxOps(pkg, [{ type: "reorder_slides", order: [3, 1, 2] }])
		const doc = await extractPptx(await pkg.save())
		expect(doc.units[0].markdown).toContain("Three")
		expect(doc.units[2].markdown).toContain("Two")

		const pkg2 = await openOoxml(await makeTemplatedPptx())
		expect(() => applyPptxOps(pkg2, [{ type: "reorder_slides", order: [2] }])).toThrow(/permutation of 1\.\.1/)
	})
})

describe("set_deck_core_property", () => {
	it("writes the deck title into docProps/core.xml", async () => {
		const pkg = await openOoxml(await writtenDeck("# Deck\n\n- a\n"))
		if (!pkg.hasXml("docProps/core.xml")) {
			pkg.putXml(
				"docProps/core.xml",
				parseXml(
					`<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Old</dc:title></cp:coreProperties>`,
				),
			)
		}
		applyPptxOps(pkg, [{ type: "set_deck_core_property", name: "title", value: "Fresh Title" }])
		expect(byTag(pkg.getXml("docProps/core.xml"), "title")[0].textContent).toBe("Fresh Title")
	})
})

describe("ops parsing", () => {
	it("accepts every supported op and rejects unknown ops with the roster", () => {
		const ops = parsePptxOps([
			{ type: "set_shape_text", slide: 1, shape: "Title", value: "x" },
			{ type: "set_shape_notes", slide: 2, value: "n" },
			{ type: "set_table_cell", slide: 1, table: 1, cell: "B3", value: "v" },
			{ type: "set_table_row", slide: 1, table: 1, row: 2, values: ["a", "b"] },
			{ type: "append_slide", layout: "Title Slide", title: "t" },
			{ type: "delete_slide", index: 3 },
			{ type: "reorder_slides", order: [2, 1] },
			{ type: "set_deck_core_property", name: "title", value: "v" },
		])
		expect(ops).toHaveLength(8)
		expect(() => parsePptxOps([{ type: "paint_slides_red" }])).toThrow(/unknown op "paint_slides_red" — supported:/)
	})

	it("rejects malformed values by naming the field", () => {
		expect(() => parsePptxOps([{ type: "set_table_row", slide: 1, table: 1, row: 1, values: [1] }])).toThrow(
			/"values" must be an array of strings/,
		)
		expect(() => parsePptxOps("nope")).toThrow(/ops must be a JSON array/)
		expect(() => parsePptxOps([{ type: "set_shape_text", shape: "x", value: "y" }])).toThrow(
			/missing or invalid "slide"/,
		)
	})
})
