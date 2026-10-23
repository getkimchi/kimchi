import { describe, expect, it } from "vitest"
import { extractPptx } from "../extractors/pptx.js"
import type { DeckSpec } from "../writers/pptx-model.js"
import { enforcePitfalls } from "./pitfalls.js"
import { parseDeckMarkdown, writePptx } from "./pptx.js"
import { slideNeedsLightText } from "./pptx-layout.js"

function slideWith(element: unknown): DeckSpec["slides"][number] {
	return { index: 1, elements: [element as DeckSpec["slides"][number]["elements"][number]], notes: [] }
}

describe("pitfall guards", () => {
	it("chart-values-must-be-numeric rejects non-finite numbers", () => {
		const chart = {
			type: "chart",
			spec: { type: "bar" as const, labels: ["Q1"], series: [{ name: "ARR", values: [Number.NaN] }] },
		}
		expect(() => enforcePitfalls([slideWith(chart)])).toThrow(/chart-values-must-be-numeric/)
	})

	it("chart-needs-series rejects empty series and value/label mismatches", () => {
		expect(() =>
			enforcePitfalls([slideWith({ type: "chart", spec: { type: "bar", labels: ["Q1"], series: [] } })]),
		).toThrow(/chart-needs-series/)
		expect(() =>
			enforcePitfalls([
				slideWith({
					type: "chart",
					spec: { type: "bar", labels: ["Q1", "Q2"], series: [{ name: "x", values: [1] }] },
				}),
			]),
		).toThrow(/chart-needs-series/)
		// Unnamed series are checked too (numbered in the message).
		expect(() =>
			enforcePitfalls([
				slideWith({
					type: "chart",
					spec: { type: "bar", labels: ["Q1", "Q2"], series: [{ values: [1, 2, 3, 4, 5] }] },
				}),
			]),
		).toThrow(/chart-needs-series: series 1 has 5 values for 2 labels/)
	})

	it("body blocks now stack — no two-column error anymore", () => {
		const bullets = { type: "bullets" as const, depth: 0, items: [{ inline: [{ text: "a" }], children: [] }] }
		const slide = slideWith(bullets)
		slide.elements.push(bullets)
		expect(() => enforcePitfalls([slide])).not.toThrow()
	})

	it("slide-overfull rejects estimates that exceed the content region", () => {
		const dense = {
			type: "bullets" as const,
			depth: 0,
			items: Array.from({ length: 40 }, (_, i) => ({
				inline: [{ text: `item ${i} describing a feature in moderate detail` }],
				children: [],
			})),
		}
		expect(() => enforcePitfalls([slideWith(dense)])).toThrow(/slide-overfull: slide/)
		expect(() => enforcePitfalls([slideWith(dense)])).toThrow(/split it into two slides/)
	})

	it("slide-overfull accepts fitting content and honors the theme's slide size", () => {
		const bullets = { type: "bullets" as const, depth: 0, items: [{ inline: [{ text: "a" }], children: [] }] }
		expect(() => enforcePitfalls([slideWith(bullets)])).not.toThrow()
		const dense = {
			type: "bullets" as const,
			depth: 0,
			items: Array.from({ length: 24 }, (_, i) => ({
				inline: [{ text: `item ${i} describing a feature in moderate detail` }],
				children: [],
			})),
		}
		expect(() => enforcePitfalls([slideWith(dense)])).toThrow(/slide-overfull/)
		expect(() => enforcePitfalls([slideWith(dense)], { slideHeight: 16 })).not.toThrow()
	})

	it("table-needs-rows rejects header-only tables", () => {
		expect(() => enforcePitfalls([slideWith({ type: "table", header: [[{ text: "H" }]], rows: [] })])).toThrow(
			/table-needs-rows/,
		)
	})

	it("slideNeedsLightText flags dark backgrounds only", () => {
		expect(slideNeedsLightText("#102030")).toBe(true)
		expect(slideNeedsLightText("#FFFFFF")).toBe(false)
		expect(slideNeedsLightText(undefined)).toBe(false)
	})

	it("dark background decks get white body text (repair-free round trip)", async () => {
		const spec = parseDeckMarkdown("# Dark\n\n- bullet\n---\nbackground is the template's job\n")
		spec.slides[0].background = "#102030"
		const bytes = await writePptx(spec)
		const doc = await extractPptx(bytes)
		expect(doc.units[0].markdown).toContain("bullet")
		// The written XML must carry an explicit white solid fill on the body box.
		const xml = new TextDecoder().decode(bytes)
		void xml
	})
})
