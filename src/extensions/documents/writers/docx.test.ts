import { describe, expect, it } from "vitest"
import { createPinnedClock } from "../clock.js"
import { extractDocx } from "../extractors/docx.js"
import { parseMarkdownBlocks } from "../markdown/blocks.js"
import { writeDocx } from "./docx.js"

const clock = createPinnedClock()

describe("writeDocx", () => {
	it("round-trips headings, paragraphs, lists, tables and code through the extractor", async () => {
		const md = [
			"# Quarterly Report",
			"",
			"Revenue **grew** in *Q3*.",
			"",
			"- First bullet",
			"  - Nested bullet",
			"",
			"1. First item",
			"2. Second item",
			"",
			"| Name | Value |",
			"| --- | --- |",
			"| alpha | 42 |",
			"| beta | 7 |",
			"",
			"```ts",
			"const x: number = 1",
			'console.log("hi")',
			"```",
		].join("\n")
		const bytes = await writeDocx({ blocks: parseMarkdownBlocks(md) }, { clock })
		const doc = await extractDocx(bytes)
		const out = doc.window().markdown
		expect(out).toContain("p1: # Quarterly Report")
		expect(out).toContain("p2: Revenue grew in Q3.")
		expect(out).toContain("p3: - First bullet")
		expect(out).toContain("p4:   - Nested bullet")
		expect(out).toContain("p5: 1. First item")
		expect(out).toContain("p6: 1. Second item")
		expect(out).toContain("[table 1]")
		expect(out).toContain("| Name | Value |")
		expect(out).toContain("| alpha | 42 |")
	})

	it("is byte-identical across two runs with the clock pinned", async () => {
		const blocks = parseMarkdownBlocks("# Same\nText with\na line break.")
		const [a, b] = await Promise.all([writeDocx({ blocks }, { clock }), writeDocx({ blocks }, { clock })])
		expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
	})

	it("splits multi-line runs (no raw \\n swallowed by Word)", async () => {
		const blocks = parseMarkdownBlocks("line one\nline two")
		const bytes = await writeDocx({ blocks }, { clock })
		const text = (await extractDocx(bytes)).window().markdown
		expect(text).toContain("line one")
		expect(text).toContain("line two")
	})

	it("applies explicit page size in section properties", async () => {
		const blocks = parseMarkdownBlocks("# P")
		const a4 = await writeDocx({ blocks }, { clock, pageSize: "A4" })
		const letter = await writeDocx({ blocks }, { clock, pageSize: "Letter" })
		const { openOoxml } = await import("../ooxml/package.js")
		const w = (await openOoxml(a4)).getXml("word/document.xml")
		const sect = w.getElementsByTagName("w:pgSz").item(0) as { getAttribute(n: string): string }
		expect(sect.getAttribute("w:w")).toBe("11906")
		const w2 = (await openOoxml(letter)).getXml("word/document.xml")
		const sect2 = w2.getElementsByTagName("w:pgSz").item(0) as { getAttribute(n: string): string }
		expect(sect2.getAttribute("w:w")).toBe("12240")
	})

	it("extracts hyperlinks as text (href preserved is nice-to-have in v1)", async () => {
		const blocks = parseMarkdownBlocks("See [the docs](https://example.com/x).")
		const bytes = await writeDocx({ blocks }, { clock })
		expect((await extractDocx(bytes)).window().markdown).toContain("the docs")
	})
})
