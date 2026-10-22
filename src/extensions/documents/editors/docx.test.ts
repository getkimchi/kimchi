import { describe, expect, it } from "vitest"
import { extractDocx } from "../extractors/docx.js"
import { makeCustomDocx, makeSimpleDocx } from "../fixtures/builders.js"
import { openOoxml } from "../ooxml/package.js"
import { applyDocxOps, markdownToBodyXml, parseDocxOps } from "./docx.js"

async function openDocx(data: Uint8Array) {
	return openOoxml(data)
}

async function saved(pkg: Awaited<ReturnType<typeof openOoxml>>): Promise<Uint8Array> {
	return pkg.save()
}

describe("parseDocxOps", () => {
	it("parses each op shape and reports unknown ops with the supported list", () => {
		const ops = parseDocxOps([
			{ type: "replace-text", anchor: "a", value: "b" },
			{ type: "replace-text", anchor: "a", value: "b", all: true },
			{ type: "delete", anchor: "x" },
			{ type: "set-table-cell", table: 1, row: 2, column: 3, value: "v" },
			{ type: "add-comment", anchor: "a", value: "c", author: "me" },
		])
		expect(ops).toHaveLength(5)
		expect(() => parseDocxOps([{ type: "magic" }])).toThrow(/unknown op/)
		expect(() => parseDocxOps([{ type: "delete" }])).toThrow(/missing or non-string "anchor"/)
		expect(() => parseDocxOps([{ type: "set-table-cell", table: 0, row: 1, column: 1, value: "x" }])).toThrow(
			/missing or invalid "table"/,
		)
	})
})

describe("applyDocxOps", () => {
	it("replace-text edits a unique anchor run-aware", async () => {
		const pkg = await openDocx(await makeSimpleDocx())
		const result = applyDocxOps(
			pkg,
			parseDocxOps([{ type: "replace-text", anchor: "Revenue grew", value: "Revenue soared" }]),
		)
		expect(result.trackedChangesPresent).toBe(true)
		const out = await extractDocx(await saved(pkg))
		expect(out.blockText(2)).toBe("Revenue soared in Q3.")
		// untouched content intact (other paragraphs unchanged)
		expect(out.blockText(1)).toBe("Quarterly Report")
	})

	it("keeps the first run's formatting when the match spans runs", async () => {
		const pkg = await openDocx(
			await makeCustomDocx(
				`<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>bold part</w:t></w:r><w:r><w:t> and plain</w:t></w:r></w:p>`,
			),
		)
		applyDocxOps(pkg, parseDocxOps([{ type: "replace-text", anchor: "part and", value: "whole" }]))
		const xml = new TextDecoder().decode(pkg.getBytes("word/document.xml"))
		expect(xml).toContain("<w:b/>")
		expect((await extractDocx(await saved(pkg))).blockText(1)).toBe("bold whole plain")
	})

	it("fails an ambiguous anchor with count and block numbers", async () => {
		const pkg = await openDocx(
			await makeCustomDocx(`<w:p><w:r><w:t>apple pie</w:t></w:r></w:p><w:p><w:r><w:t>apple tart</w:t></w:r></w:p>`),
		)
		expect(() => applyDocxOps(pkg, parseDocxOps([{ type: "replace-text", anchor: "apple", value: "pear" }]))).toThrow(
			/matches 2 paragraphs/,
		)
	})

	it("replace-text --all replaces every occurrence", async () => {
		const pkg = await openDocx(
			await makeCustomDocx(`<w:p><w:r><w:t>apple pie</w:t></w:r></w:p><w:p><w:r><w:t>apple tart</w:t></w:r></w:p>`),
		)
		applyDocxOps(pkg, parseDocxOps([{ type: "replace-text", anchor: "apple", value: "pear", all: true }]))
		const doc = await extractDocx(await saved(pkg))
		expect(doc.blockText(1)).toBe("pear pie")
		expect(doc.blockText(2)).toBe("pear tart")
	})

	it("delete removes the paragraph containing a unique anchor", async () => {
		const pkg = await openDocx(
			await makeCustomDocx(
				`<w:p><w:r><w:t>Keep me</w:t></w:r></w:p><w:p><w:r><w:t>Delete me</w:t></w:r></w:p><w:p><w:r><w:t>Keep too</w:t></w:r></w:p>`,
			),
		)
		const result = applyDocxOps(pkg, parseDocxOps([{ type: "delete", anchor: "Delete me" }]))
		expect(result.applied[0]).toContain("deleted block 2")
		const doc = await extractDocx(await saved(pkg))
		expect(doc.totalBlocks).toBe(2)
		expect(doc.blockText(1)).toBe("Keep me")
		expect(doc.blockText(2)).toBe("Keep too")
	})

	it("preserves existing tracked changes untouched while editing elsewhere", async () => {
		const pkg = await openDocx(await makeSimpleDocx())
		applyDocxOps(pkg, parseDocxOps([{ type: "replace-text", anchor: "Revenue grew", value: "Revenue soared" }]))
		const xml = new TextDecoder().decode(pkg.getBytes("word/document.xml"))
		expect(xml).toContain('<w:ins w:id="10" w:author="Alice"')
		expect(xml).toContain('<w:del w:id="11" w:author="Bob"')
		expect(xml).toContain("<w:delText>Deleted words.</w:delText>")
	})

	it("untouched zip parts survive byte-identical", async () => {
		const input = await makeSimpleDocx()
		const inPkg = await openOoxml(input)
		const before = new Map<string, Uint8Array>()
		for (const name of inPkg.names()) {
			const bytes = inPkg.getBytes(name)
			if (!bytes) throw new Error(`fixture part ${name} unreadable`)
			before.set(name, bytes)
		}
		applyDocxOps(inPkg, parseDocxOps([{ type: "replace-text", anchor: "Revenue grew", value: "Revenue soared" }]))
		const out = await inPkg.save()
		const outPkg = await openOoxml(out)
		for (const [name, bytes] of before) {
			if (name === "word/document.xml") continue
			const after = outPkg.getBytes(name)
			if (!after) throw new Error(`part ${name} missing after edit`)
			expect(Buffer.from(after).equals(Buffer.from(bytes)), `part ${name} changed`).toBe(true)
		}
	})

	it("insert-after/before place Markdown content next to the anchor block", async () => {
		const pkg = await openDocx(
			await makeCustomDocx(`<w:p><w:r><w:t>Anchor para</w:t></w:r></w:p><w:p><w:r><w:t>Other para</w:t></w:r></w:p>`),
		)
		applyDocxOps(
			pkg,
			parseDocxOps([
				{ type: "insert-after", anchor: "Anchor para", value: "## New Section\n\nFresh **text**." },
				{ type: "insert-before", anchor: "Anchor para", value: "Lead-in." },
			]),
		)
		const doc = await extractDocx(await saved(pkg))
		expect(doc.blockText(1)).toBe("Lead-in.")
		expect(doc.blockText(2)).toBe("Anchor para")
		expect(doc.blockText(3)).toBe("New Section")
		expect(doc.blockText(4)).toBe("Fresh text.")
		expect(doc.blockText(5)).toBe("Other para")
	})

	it("append lands before the final sectPr", async () => {
		const pkg = await openDocx(await makeCustomDocx(`<w:p><w:r><w:t>First</w:t></w:r></w:p>`))
		applyDocxOps(pkg, parseDocxOps([{ type: "append", value: "Tail end." }]))
		const doc = await extractDocx(await saved(pkg))
		expect(doc.blockText(2)).toBe("Tail end.")
		const xml = new TextDecoder().decode(pkg.getBytes("word/document.xml"))
		expect(xml.indexOf("Tail end.")).toBeLessThan(xml.indexOf("<w:sectPr"))
	})

	it("insert rejects images and tables with guidance", async () => {
		expect(() => markdownToBodyXml("![pic](a.png)")).toThrow(/does not support images/)
		expect(() => markdownToBodyXml("| A |\n|---|\n| 1 |")).toThrow(/does not support tables/)
	})

	it("set-table-cell edits a cell and keeps the table structure", async () => {
		const pkg = await openDocx(await makeSimpleDocx())
		applyDocxOps(pkg, parseDocxOps([{ type: "set-table-cell", table: 1, row: 2, column: 2, value: "B-NEW" }]))
		const doc = await extractDocx(await saved(pkg))
		const w = doc.window({ start: 9, end: 9 })
		expect(w.markdown).toContain("| A2 | B-NEW |")
		// row 1 untouched
		expect(w.markdown).toContain("| A1 | B1 |")
	})

	it("set-table-cell reports out-of-range rows and columns", async () => {
		const pkg = await openDocx(await makeSimpleDocx())
		expect(() =>
			applyDocxOps(pkg, parseDocxOps([{ type: "set-table-cell", table: 1, row: 9, column: 1, value: "x" }])),
		).toThrow(/has 2 rows/)
		expect(() =>
			applyDocxOps(pkg, parseDocxOps([{ type: "set-table-cell", table: 1, row: 1, column: 9, value: "x" }])),
		).toThrow(/has 2 cells/)
	})

	it("add-comment wraps the paragraph and creates missing comment parts", async () => {
		const pkg = await openDocx(await makeCustomDocx(`<w:p><w:r><w:t>Target text</w:t></w:r></w:p>`))
		const result = applyDocxOps(
			pkg,
			parseDocxOps([{ type: "add-comment", anchor: "Target text", value: "Please reword.", author: "Reviewer" }]),
		)
		expect(result.commentsAdded).toBe(1)
		const docXml = new TextDecoder().decode(pkg.getBytes("word/document.xml"))
		expect(docXml).toContain('<w:commentRangeStart w:id="0"/>')
		expect(docXml).toContain('<w:commentRangeEnd w:id="0"/>')
		expect(docXml).toContain('<w:commentReference w:id="0"/>')
		const comments = new TextDecoder().decode(pkg.getBytes("word/comments.xml"))
		expect(comments).toContain('w:author="Reviewer"')
		expect(comments).toContain("Please reword.")
		expect(new TextDecoder().decode(pkg.getBytes("[Content_Types].xml"))).toContain("comments+xml")
		// And it reads back as an annotation.
		const doc = await extractDocx(await pkg.save())
		expect(doc.info.comments).toBe(1)
		expect(doc.window().markdown).toContain("> [comment 0] Reviewer: Please reword.")
	})

	it("add-comment appends to an existing comments part with the next id", async () => {
		const pkg = await openOoxml(await makeSimpleDocx()) // already has comment id 0
		applyDocxOps(
			pkg,
			parseDocxOps([{ type: "add-comment", anchor: "Revenue grew", value: "Second comment.", author: "Me" }]),
		)
		const comments = new TextDecoder().decode(pkg.getBytes("word/comments.xml"))
		expect(comments).toContain('w:id="1"')
		expect(comments).toContain("Fix this.") // original preserved
	})

	it("sequential ops see the latest document state", async () => {
		const pkg = await openOoxml(
			await makeCustomDocx(`<w:p><w:r><w:t>Alpha</w:t></w:r></w:p><w:p><w:r><w:t>Beta</w:t></w:r></w:p>`),
		)
		applyDocxOps(
			pkg,
			parseDocxOps([
				{ type: "insert-after", anchor: "Alpha", value: "Middle" },
				{ type: "delete", anchor: "Beta" },
				{ type: "replace-text", anchor: "Middle", value: "Center" },
			]),
		)
		const doc = await extractDocx(await pkg.save())
		expect(doc.totalBlocks).toBe(2)
		expect(doc.blockText(1)).toBe("Alpha")
		expect(doc.blockText(2)).toBe("Center")
	})

	it("a randomized op sequence stays readable (property-style smoke)", async () => {
		const words = ["alpha", "beta", "gamma", "delta", "epsilon"]
		let seed = 42
		const rand = () => {
			seed = (seed * 1103515245 + 12345) % 2147483648
			return seed / 2147483648
		}
		const paras = Array.from(
			{ length: 30 },
			(_, i) => `<w:p><w:r><w:t>${words[i % 5]} sentence ${i}</w:t></w:r></w:p>`,
		).join("")
		const pkg = await openOoxml(await makeCustomDocx(paras))
		for (let k = 0; k < 25; k++) {
			const i = Math.floor(rand() * 30)
			const choice = rand()
			const current = new TextDecoder().decode(pkg.getBytes("word/document.xml"))
			const anchor = `${words[i % 5]} sentence ${i}`
			// "sentence 1" is a substring of "sentence 11": skip ambiguous picks
			// (the ambiguous-anchor error case has its own dedicated test above).
			if (current.split(anchor).length - 1 !== 1) continue
			const ops =
				choice < 0.4
					? [{ type: "replace-text", anchor, value: `changed ${i}` }]
					: choice < 0.7
						? [{ type: "insert-after", anchor, value: `inserted ${i}` }]
						: [{ type: "delete", anchor }]
			applyDocxOps(pkg, parseDocxOps(ops))
		}
		const doc = await extractDocx(await pkg.save())
		expect(doc.totalBlocks).toBeGreaterThan(0)
		expect(doc.window({ start: 1, end: Math.min(doc.totalBlocks, 10) }).markdown.length).toBeGreaterThan(0)
	})
})
