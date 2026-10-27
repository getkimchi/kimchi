import { describe, expect, it } from "vitest"
import { makeSimplePptx, makeTemplatedPptx } from "./fixtures/builders.js"
import { inspectPptx, renderInspection } from "./pptx-inspect.js"

describe("inspectPptx", () => {
	it("lists layouts, placeholders, and exact shape names per slide", async () => {
		const deck = await inspectPptx(await makeTemplatedPptx())
		expect(deck.slideSizePt).toEqual({ width: 720, height: 540 })
		expect(deck.layouts).toEqual([
			{
				name: "Title and Content",
				placeholders: [
					{ type: "title", idx: 0 },
					{ type: "body", idx: 1 },
				],
			},
		])
		expect(deck.slides).toHaveLength(1)
		const [slide] = deck.slides
		expect(slide.layoutName).toBe("Title and Content")
		expect(slide.shapes).toEqual([
			{ name: "Title 1", placeholder: { type: "title", idx: undefined }, chars: 7 },
			{ name: "Content Placeholder 2", placeholder: { type: "body", idx: 1 }, chars: 21 },
		])
	})

	it('renders names in the [shape "..."] form edit accepts', async () => {
		const deck = await inspectPptx(await makeTemplatedPptx())
		const text = renderInspection(deck)
		expect(text).toContain('layout "Title and Content" — placeholders: title idx 0, body idx 1')
		expect(text).toContain('slide 1 layout "Title and Content"')
		expect(text).toContain('[shape "Title 1"] placeholder(title) 7 chars')
		expect(text).toContain('[shape "Content Placeholder 2"] placeholder(body, idx 1) 21 chars')
	})

	it("lists tables with their document-order indices", async () => {
		const deck = await inspectPptx(await makeSimplePptx())
		const tableSlide = deck.slides[2]
		expect(tableSlide.tables).toEqual([{ index: 1, rows: 2, cols: 2 }])
		expect(renderInspection(deck)).toContain("[table 1] 2 rows x 2 cols")
	})

	it("handles decks without layouts", async () => {
		const deck = await inspectPptx(await makeSimplePptx())
		expect(deck.slides).toHaveLength(3)
		expect(deck.slides[2].hidden).toBe(true)
		expect(renderInspection(deck)).toContain("slide 3 (hidden)")
	})

	it("throws a typed error for a corrupt package", async () => {
		await expect(inspectPptx(new Uint8Array([0x50, 0x4b, 1, 2]))).rejects.toMatchObject({ code: "corrupt" })
	})
})
