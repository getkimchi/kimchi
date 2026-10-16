import { describe, expect, it } from "vitest"
import { extractPptx } from "../extractors/pptx.js"
import { parseDeckMarkdown, writePptx } from "./pptx.js"

const DECK_MD = `---
title: Q3 Review
author: Platform Team
---

# Q3 Review

- Revenue up 12%
- Costs flat

---

# By the numbers

| Metric | Q2 | Q3 |
| ------ | -- | -- |
| ARR    | 10 | 11 |

\`\`\`chart
{"type": "bar", "labels": ["Q2", "Q3"], "series": [{"name": "ARR", "values": [10, 11]}]}
\`\`\`

Notes: remember to thank sponsors
`

describe("parseDeckMarkdown", () => {
	it("parses frontmatter, slides, lists, tables, charts and notes", () => {
		const spec = parseDeckMarkdown(DECK_MD)
		expect(spec.meta).toEqual({ title: "Q3 Review", author: "Platform Team" })
		expect(spec.slides).toHaveLength(2)
		expect(spec.slides[0].heading).toBe("Q3 Review")
		expect(spec.slides[0].elements[0].type).toBe("bullets")
		expect(spec.slides[1].elements.some((e) => e.type === "table")).toBe(true)
		expect(spec.slides[1].elements.some((e) => e.type === "chart")).toBe(true)
		expect(spec.slides[1].notes).toEqual(["remember to thank sponsors"])
	})

	it("strips read-output locators (`## Slide N`, shape/table/chart markers)", () => {
		const spec = parseDeckMarkdown(
			'## Slide 1\n\n# Kickoff\n\n[shape "Title 1"]\nBody\n\n[table 1]\n\n[chart]\n\nNotes: hi\n',
		)
		expect(spec.slides).toHaveLength(1)
		expect(spec.slides[0].heading).toBe("Kickoff")
		expect(JSON.stringify(spec.slides[0])).not.toContain("Title 1")
	})

	it("parses layout hints off the heading", () => {
		const spec = parseDeckMarkdown("# Two ways :: two-column\n\n- a\n\n- b\n")
		expect(spec.slides[0].layoutHint).toBe("two-column")
		expect(spec.slides[0].heading).toBe("Two ways")
	})

	it("errors name the slide: unknown chart type", () => {
		expect(() => parseDeckMarkdown('# A\n\n```chart\n{"type": "scatter", "labels": [], "series": []}\n```\n')).toThrow(
			/slide 1: unknown chart type "scatter"/,
		)
	})

	it("errors name the failure: malformed chart JSON", () => {
		expect(() => parseDeckMarkdown("# A\n\n```chart\nnot json\n```\n")).toThrow(
			/slide 1: chart block is not valid JSON/,
		)
	})

	it("errors on remote image URLs, accepting local ones", () => {
		expect(() => parseDeckMarkdown("# A\n\n![pic](https://x/y.png)\n")).toThrow(/only local filesystem paths/)
		expect(parseDeckMarkdown("# A\n\n![pic](img.png)\n").slides[0].elements[0]).toEqual({
			type: "image",
			path: "img.png",
			alt: "pic",
		})
	})

	it("errors on an empty deck", () => {
		expect(() => parseDeckMarkdown("---\ntitle: only meta\n---\n")).toThrow(/no slides/)
	})
})

describe("writePptx round trips through the extractor", () => {
	it("create → read: titles, bullets, tables, notes, slide count", async () => {
		const bytes = await writePptx(parseDeckMarkdown(DECK_MD))
		const doc = await extractPptx(bytes)
		expect(doc.units).toHaveLength(2)
		expect(doc.outline[0]).toContain("Q3 Review")
		expect(doc.units[0].markdown).toContain("Revenue up 12%")
		expect(doc.units[1].markdown).toContain("| Metric | Q2 | Q3 |")
		expect(doc.units[1].markdown).toContain("remember to thank sponsors")
	})

	it("nested bullets keep their text", async () => {
		const bytes = await writePptx(parseDeckMarkdown("# N\n\n- top\n  - child\n"))
		const doc = await extractPptx(bytes)
		expect(doc.units[0].markdown).toContain("child")
	})

	it("layout hints don't leak into the slide text", async () => {
		const bytes = await writePptx(parseDeckMarkdown("# A :: two-column\n\n- a\n\n- b\n\n- c\n"))
		const doc = await extractPptx(bytes)
		expect(doc.units[0].markdown).not.toContain("two-column")
	})

	it("repeated writes byte-stable? Only shape-stable — content round-trips", async () => {
		const spec = parseDeckMarkdown("# A\n\n- one\n")
		const a = await extractPptx(await writePptx(spec))
		const b = await extractPptx(await writePptx(spec))
		expect(a).toEqual(b)
	})
})

describe("writePptx image rules", () => {
	it("rejects unsupported image extensions and missing files", async () => {
		const spec = parseDeckMarkdown("# A\n\n![p](x.bmp)\n")
		await expect(writePptx(spec, { fileExists: () => true, fileSize: () => 1 })).rejects.toMatchObject({
			code: "unsupported-format",
		})
		const spec2 = parseDeckMarkdown("# A\n\n![p](gone.png)\n")
		await expect(writePptx(spec2, { fileExists: () => false, fileSize: () => 1 })).rejects.toMatchObject({
			code: "corrupt",
		})
	})

	it("rejects images over the 20 MB cap", async () => {
		const spec = parseDeckMarkdown("# A\n\n![p](big.png)\n")
		await expect(writePptx(spec, { fileExists: () => true, fileSize: () => 25 * 1024 * 1024 })).rejects.toMatchObject({
			code: "too-large",
		})
	})
})
