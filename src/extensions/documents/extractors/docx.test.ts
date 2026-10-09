import { describe, expect, it } from "vitest"
import { extractDocument } from "../extract.js"
import { makeSimpleDocx } from "../fixtures/builders.js"

describe("extractDocument(docx)", () => {
	it("renders headings, paragraphs, and tables with locators", async () => {
		const doc = await extractDocument("report.docx", await makeSimpleDocx())
		expect(doc.format).toBe("docx")
		expect(doc.unitKind).toBe("document")
		expect(doc.units).toHaveLength(1)
		const md = doc.units[0].markdown
		expect(md).toContain("# Quarterly Report")
		expect(md).toContain("Revenue grew in Q3 across all regions.")
		expect(md).toContain("[table 1]")
		expect(md).toContain("| Region | Amount |")
		expect(md).toContain("| North | 42 |")
		// Heading-based outline
		expect(doc.outline).toContain("# Quarterly Report")
	})

	it("maps a random zip with a word part but invalid XML to a typed error", async () => {
		const { openOoxml } = await import("../ooxml/package.js")
		const { saveWith } = await __import_fixture_helpers()
		void openOoxml
		const bad = await saveWith({ "word/document.xml": "<w:document><unclosed>" })
		await expect(extractDocument("bad.docx", bad)).rejects.toMatchObject({ name: "DocumentError" })
	})
})

async function __import_fixture_helpers() {
	// Local helper kept out of test-fixtures.ts: builds arbitrary zips.
	const JSZip = (await import("jszip")).default
	return {
		async saveWith(entries: Record<string, string>): Promise<Uint8Array> {
			const zip = new JSZip()
			for (const [name, content] of Object.entries(entries)) zip.file(name, content)
			return zip.generateAsync({ type: "uint8array" })
		},
	}
}
