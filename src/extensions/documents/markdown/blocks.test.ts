import { describe, expect, it } from "vitest"
import { type Block, parseMarkdownBlocks } from "./blocks.js"

describe("parseMarkdownBlocks", () => {
	it("parses headings with level and inline styling", () => {
		const blocks = parseMarkdownBlocks("# Hello *world*")
		expect(blocks).toEqual([
			{ type: "heading", level: 1, inline: [{ text: "Hello " }, { text: "world", italic: true }] },
		])
	})

	it("parses paragraphs with bold/code/link runs merged", () => {
		const blocks = parseMarkdownBlocks("plain **bold** `code` [link](https://x.y) tail")
		const p = blocks[0] as Extract<Block, { type: "paragraph" }>
		expect(p.inline).toEqual([
			{ text: "plain " },
			{ text: "bold", bold: true },
			{ text: " " },
			{ text: "code", code: true },
			{ text: " " },
			{ text: "link", href: "https://x.y" },
			{ text: " tail" },
		])
	})

	it("splits pages on form-feed and --- lines", () => {
		const blocks = parseMarkdownBlocks("first\n\n---\n\nsecond\n\ft\nhird")
		const types = blocks.map((b) => b.type)
		expect(types).toContain("pagebreak")
		expect(types.filter((t) => t === "paragraph")).toHaveLength(3)
	})

	it("parses lists (ordered and unordered) with nested blocks", () => {
		const blocks = parseMarkdownBlocks("- a\n- b\n\n1. x\n2. y")
		expect(blocks[0]).toMatchObject({ type: "list", ordered: false })
		expect(blocks[1]).toMatchObject({ type: "list", ordered: true, start: 1 })
	})

	it("parses tables with per-cell inline runs", () => {
		const blocks = parseMarkdownBlocks("| A | B |\n|---|---|\n| 1 | **two** |")
		const t = blocks[0] as Extract<Block, { type: "table" }>
		expect(t.header[0][0]).toEqual({ text: "A" })
		expect(t.rows[0][1][0]).toMatchObject({ text: "two", bold: true })
	})

	it("maps ```chart fences to chart blocks and other fences to code", () => {
		const blocks = parseMarkdownBlocks('```chart\n{"kind":"bar"}\n```\n\n```ts\nconst x=1\n```')
		expect(blocks[0]).toEqual({ type: "chart", spec: '{"kind":"bar"}' })
		expect(blocks[1]).toMatchObject({ type: "code", lang: "ts", code: "const x=1" })
	})

	it("drops HR tokens and html blocks silently", () => {
		expect(parseMarkdownBlocks("a\n\n***\n\nb").map((b) => b.type)).toEqual(["paragraph", "paragraph"])
	})
})
