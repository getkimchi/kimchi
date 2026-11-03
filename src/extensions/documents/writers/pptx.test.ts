import JSZip from "jszip"
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

	// Regression: `:: hint` on a sub-heading used to be rendered literally
	// ("What we verify :: content"). Now it sets the slide's layout and is
	// stripped from the text; unknown ":: whatever" stays as prose.
	it("parses layout hints off sub-headings and strips them from the text", () => {
		const spec = parseDeckMarkdown("# Deck\n\n---\n\n## What we verify :: content\n\nbody\n\n---\n\n## Revenue :: Q3\n")
		const s2 = spec.slides[1]
		expect(s2.layoutHint).toBe("content")
		const heading = s2.elements[0]
		expect(heading.type === "heading" && heading.inline.map((i) => i.text).join("")).toBe("What we verify")
		// Unknown hint text stays literal — it's prose, not a layout hint.
		const s3 = spec.slides[2]
		const h3 = s3.elements[0]
		expect(s3.layoutHint).toBeUndefined()
		expect(h3.type === "heading" && h3.inline.map((i) => i.text).join("")).toBe("Revenue :: Q3")
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

	it("emits no Content_Types Override for a missing part (Keynote rejects orphans)", async () => {
		const spec = parseDeckMarkdown("# A\n\n- one\n\n---\n\n# B\n\n- two\n")
		const zip = await JSZip.loadAsync(await writePptx(spec))
		const types = (await zip.file("[Content_Types].xml")?.async("string")) ?? ""
		const orphans: string[] = []
		for (const match of types.matchAll(/<Override PartName="([^"]+)"[^>]*\/>/g)) {
			const part = match[1].replace(/^\//, "")
			if (!zip.file(part)) orphans.push(match[1])
		}
		// pptxgenjs declares slideMaster{N} per slide but only writes slideMaster1.
		expect(orphans).toEqual([])
	})

	it("emits schema-valid charts: no dangling axis references, lang after date1904", async () => {
		const spec = parseDeckMarkdown(
			'# A\n\n```chart\n{"type": "bar", "labels": ["Q1", "Q2"], "series": [{"name": "ARR", "values": [9.4, 11.3]}]}\n```\n',
		)
		const zip = await JSZip.loadAsync(await writePptx(spec))
		// pptxgenjs numbers chart parts from a module-global counter — any chartN
		const chartName = Object.keys(zip.files).find((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))
		expect(chartName).toBeDefined()
		const chart = (await zip.file(chartName ?? "")?.async("string")) ?? ""
		// every axId referenced by a chart type must be defined by an axis element
		const defined = new Set(
			[...chart.matchAll(/<c:(?:catAx|valAx|serAx|dateAx)>\s*<c:axId val="(\d+)"\/>/g)].map((m) => m[1]),
		)
		expect(defined.size).toBe(2) // cat + val
		for (const match of chart.matchAll(/<c:axId val="(\d+)"\/>/g)) {
			expect(defined.has(match[1])).toBe(true)
		}
		// chartSpace sequence: date1904? then lang?
		const langPos = chart.indexOf("<c:lang")
		const datePos = chart.indexOf("<c:date1904")
		expect(langPos).toBeGreaterThan(-1)
		if (datePos > -1) expect(langPos).toBeGreaterThan(datePos)
		// the embedded workbook ships with a repaired table ref — pptxgenjs
		// writes a stray quote into it (ref="A1:B5'") and Keynote's chart
		// importer rejects the whole chart for the malformed range
		const workbookName = Object.keys(zip.files).find((n) => /^ppt\/embeddings\/[^/]+\.xlsx$/.test(n))
		expect(workbookName).toBeDefined()
		const workbook = await JSZip.loadAsync(
			(await zip.file(workbookName ?? "")?.async("nodebuffer")) ?? new Uint8Array(),
		)
		for (const part of Object.keys(workbook.files)) {
			if (!/^xl\/tables\/table\d+\.xml$/.test(part)) continue
			const tableXml = (await workbook.file(part)?.async("string")) ?? ""
			const ref = /ref="([^"]*)"/.exec(tableXml)?.[1] ?? ""
			expect(ref).toMatch(/^[A-Z]+\d+:[A-Z]+\d+$/)
		}
	})
})

describe("design blocks (stats/quote/cards/flow/code)", () => {
	it("parses stats entries from `value | label` lines", () => {
		const spec = parseDeckMarkdown("# G\n\n```stats\n$0 | past-cap spend\n4 levels | budget tiers\n```\n")
		expect(spec.slides[0].elements[0]).toEqual({
			type: "stats",
			entries: [
				{ value: "$0", label: "past-cap spend" },
				{ value: "4 levels", label: "budget tiers" },
			],
		})
	})

	it("stats lines without a separator are typed errors naming the slide", () => {
		expect(() => parseDeckMarkdown("# G\n\n```stats\n$0 no pipe here\n```\n")).toThrow(/slide 1: stats line needs/)
	})

	it("parses quotes with and without attribution", () => {
		const withAttr = parseDeckMarkdown(
			"# G\n\n```quote\nAuto router keeps quality high.\n| Dekel Shavit, Sr. Director\n```\n",
		)
		expect(withAttr.slides[0].elements[0]).toEqual({
			type: "quote",
			text: "Auto router keeps quality high.",
			attribution: "Dekel Shavit, Sr. Director",
		})
		const without = parseDeckMarkdown("# G\n\n```quote\nQuote text only.\n```\n")
		expect(without.slides[0].elements[0]).toEqual({ type: "quote", text: "Quote text only.", attribution: undefined })
	})

	it("parses cards, numbering them with an N. prefix", () => {
		const spec = parseDeckMarkdown("# G\n\n```cards\n1. First | body one\nSecond | body two\n```\n")
		expect(spec.slides[0].elements[0]).toEqual({
			type: "cards",
			cards: [
				{ title: "First", body: "body one", number: "1" },
				{ title: "Second", body: "body two", number: undefined },
			],
		})
	})

	it("parses flows from arrows or lines, honoring the * accent stage", () => {
		const single = parseDeckMarkdown("# G\n\n```flow\ndraft → *running → complete\n```\n")
		expect(single.slides[0].elements[0]).toEqual({
			type: "flow",
			stages: [{ label: "draft" }, { label: "running", highlight: true }, { label: "complete" }],
		})
		const lines = parseDeckMarkdown("# G\n\n```flow\nplan\nbuild\nship\n```\n")
		expect(lines.slides[0].elements[0]).toEqual({
			type: "flow",
			stages: [{ label: "plan" }, { label: "build" }, { label: "ship" }],
		})
	})

	it("parses flow stage descriptions from `Stage | description` lines", () => {
		const spec = parseDeckMarkdown("# G\n\n```flow\nBuild | compiles and tests\n*Ship | deploys to prod\n```\n")
		expect(spec.slides[0].elements[0]).toEqual({
			type: "flow",
			stages: [
				{ label: "Build", description: "compiles and tests" },
				{ label: "Ship", description: "deploys to prod", highlight: true },
			],
		})
	})

	it("untyped or code fences become terminal cards; unknown block langs are typed errors", () => {
		const spec = parseDeckMarkdown("# G\n\n```\n$ kimchi setup\n# comment\n```\n")
		expect(spec.slides[0].elements[0]).toEqual({ type: "code", lines: ["$ kimchi setup", "# comment"] })
		expect(() => parseDeckMarkdown("# G\n\n```mermaid\ngraph LR\n```\n")).toThrow(
			/slide 1: unknown block type "mermaid"/,
		)
	})

	it("the hero hint parses like other layout hints", () => {
		const spec = parseDeckMarkdown("# Kimchi :: hero\n\nYour AI. Under your control.\n")
		expect(spec.slides[0].layoutHint).toBe("hero")
		expect(spec.slides[0].heading).toBe("Kimchi")
	})

	it("kicker fences set the slide kicker; empty kickers are typed errors", () => {
		const spec = parseDeckMarkdown("```kicker\nPlatform Overview\n```\n\n# The gatekeeper\n\n- one\n")
		expect(spec.slides[0].kicker).toBe("Platform Overview")
		// Kicker is a slot, not a flow element — only the bullet remains.
		expect(spec.slides[0].elements).toEqual([
			{ type: "bullets", depth: 0, items: [{ inline: [{ text: "one" }], children: [] }] },
		])
		expect(() => parseDeckMarkdown("```kicker\n\n```\n\n# T\n")).toThrow(/"kicker" block is empty/)
	})

	it("the closing hint parses and multi-word headings keep their text", () => {
		const spec = parseDeckMarkdown("# Your AI. Under your control. :: closing\n\n- link one\n")
		expect(spec.slides[0].layoutHint).toBe("closing")
		expect(spec.slides[0].heading).toBe("Your AI. Under your control.")
	})
})

const DESIGN_DECK_MD = `---
title: Kimchi
---

# Kimchi :: hero

The governed AI coding agent.

One enforcement layer for your AI.

\`\`\`
$ brew install getkimchi/tap/kimchi
$ kimchi setup
\`\`\`

- kimchi.dev
- github.com/getkimchi/kimchi

---

# The problem

- Runaway spend
---

# Governance

\`\`\`stats
$0 | spent past the cap
4 levels | budgets per user, team, key, model\n\`\`\`

\`\`\`quote
Auto router keeps the quality of a single frontier model while cutting costs.
| Dekel Shavit, Sr. Director of Engineering
\`\`\`

---

# Milestones

\`\`\`cards
1. Hard limits | spending stops at the cap
2. Real time | attributed per request
3. Perimeter | data stays inside
\`\`\`

\`\`\`flow
draft → *running → complete
\`\`\`
`

describe("writePptx with the extended design grammar", () => {
	const THEME = {
		font: "Arial",
		headingFont: "Arial",
		accent: "#FF521D",
		background: "#0E0F13",
		footer: "kimchi · {n}",
	}

	it("hero + design blocks round trip with content intact", async () => {
		const bytes = await writePptx(parseDeckMarkdown(DESIGN_DECK_MD, THEME))
		const doc = await extractPptx(bytes)
		expect(doc.units).toHaveLength(4)
		expect(doc.units[0].markdown).toContain("Kimchi")
		expect(doc.units[0].markdown).toContain("brew install getkimchi/tap/kimchi")
		expect(doc.units[2].markdown).toContain("$0")
		expect(doc.units[2].markdown).toContain("Auto router keeps the quality")
		expect(doc.units[2].markdown).toContain("Dekel Shavit, Sr. Director of Engineering")
		expect(doc.units[3].markdown).toContain("Hard limits")
		expect(doc.units[3].markdown).toContain("draft")
	})

	it("footers render on content slides only, with the slide number expanded", async () => {
		const bytes = await writePptx(parseDeckMarkdown(DESIGN_DECK_MD, THEME))
		const doc = await extractPptx(bytes)
		expect(doc.units[0].markdown).not.toContain("kimchi · 1")
		expect(doc.units[1].markdown).toContain("kimchi · 2")
		expect(doc.units[2].markdown).toContain("kimchi · 3")
		expect(doc.units[3].markdown).toContain("kimchi · 4")
	})

	it("two body blocks now stack in source order instead of erroring", async () => {
		const bytes = await writePptx(parseDeckMarkdown("# S\n\nOne lead paragraph.\n\n- first bullet\n"))
		const doc = await extractPptx(bytes)
		expect(doc.units[0].markdown).toContain("One lead paragraph.")
		expect(doc.units[0].markdown).toContain("first bullet")
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
