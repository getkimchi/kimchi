import { describe, expect, it } from "vitest"
import {
	computeSlideLayout,
	estimateElementHeight,
	estimateOverflow,
	resolvePalette,
	slideNeedsLightText,
} from "./pptx-layout.js"
import type { DeckTheme, SlideElement, SlideSpec } from "./pptx-model.js"

function slideWith(elements: SlideElement[], heading = "H"): SlideSpec {
	return { index: 1, heading, elements, notes: [] }
}

const bullets = (lines: string[]): SlideElement => ({
	type: "bullets",
	depth: 0,
	items: lines.map((t) => ({ inline: [{ text: t }], children: [] })),
})

describe("resolvePalette", () => {
	it("light defaults keep near-black text and gitignore-quiet surfaces", () => {
		const pal = resolvePalette({})
		expect(pal.dark).toBe(false)
		expect(pal.bg).toBeUndefined()
		expect(pal.text).toBe("22262B")
		expect(pal.muted).toBe("5A6470")
		expect(pal.surface).toBe("F2F4F6")
		expect(pal.accent).toBe("00A3A1")
		expect(pal.headFont).toBe("Calibri")
		expect(pal.bodyFont).toBe("Calibri")
		expect(pal.monoFont).toBe("Courier New")
	})

	it("dark backgrounds flip text and surfaces", () => {
		const pal = resolvePalette({ background: "#0E0F13" })
		expect(pal.dark).toBe(true)
		expect(pal.text).toBe("FFFFFF")
		expect(pal.muted).toBe("9BA1AB")
		expect(pal.surface).toBe("181A21")
	})

	it("explicit theme fields always win, hashes are stripped", () => {
		const theme: DeckTheme = {
			font: "Arial",
			headingFont: "Cambria",
			monoFont: "Menlo",
			accent: "#FF521D",
			background: "#0E0F13",
			surface: "#111111",
			surface2: "#070808",
			text: "#EEEEEE",
			muted: "#888888",
			footer: "kimchi · {n}",
		}
		const pal = resolvePalette(theme)
		expect(pal.accent).toBe("FF521D")
		expect(pal.bg).toBe("0E0F13")
		expect(pal.headFont).toBe("Cambria")
		expect(pal.bodyFont).toBe("Arial")
		expect(pal.monoFont).toBe("Menlo")
		expect(pal.footer).toBe("kimchi · {n}")
	})

	it("slideNeedsLightText is the same rule the writer applies", () => {
		expect(slideNeedsLightText("#102030")).toBe(true)
		expect(slideNeedsLightText("#FFFFFF")).toBe(false)
		expect(slideNeedsLightText(undefined)).toBe(false)
	})
})

describe("computeSlideLayout", () => {
	it("stacks elements top-to-bottom in source order below the heading", () => {
		const slide = slideWith([
			bullets(["first"]),
			{ type: "stats", entries: [{ value: "$0", label: "past cap" }] },
			bullets(["tail"]),
		])
		const layout = computeSlideLayout(slide, {})
		expect(layout.heading?.y).toBeCloseTo(0.32)
		const ys = layout.flow.map((b) => b.y)
		expect(ys[0]).toBeCloseTo(1.35)
		expect(ys[1]).toBeGreaterThan(ys[0])
		expect(ys[2]).toBeGreaterThan(ys[1])
		expect(layout.flow[1].h).toBeCloseTo(1.8) // stats row
		expect(layout.contentBottom).toBeLessThan(7.08)
	})

	it("two-column splits body blocks across equal-height columns", () => {
		const slide = slideWith([bullets(["a", "b"]), bullets(["c", "d"])], "Two")
		slide.layoutHint = "two-column"
		const layout = computeSlideLayout(slide, {})
		expect(layout.columns).toHaveLength(2)
		expect(layout.columns?.[0].x).toBeCloseTo(0.6)
		expect(layout.columns?.[1].x).toBeCloseTo(0.6 + 12.13 / 2 + 0.22, 1)
		expect(layout.columns?.[0].y).toBe(layout.columns?.[1].y)
	})

	it("overfull reports how far content exceeds the region", () => {
		const dense = slideWith([
			bullets(Array.from({ length: 30 }, (_, i) => `item ${i} describing a feature in moderate detail`)),
		])
		expect(estimateOverflow(dense, {})).toBeGreaterThan(0.15)
		expect(estimateOverflow(dense, { slideHeight: 16 })).toBeLessThanOrEqual(0)
	})

	it("footers shrink the content region by exactly the footer reserve", () => {
		const slide = slideWith([bullets(["a"])])
		const withFooter = estimateOverflow(slide, { footer: "x · {n}" })
		const withoutFooter = estimateOverflow(slide, {})
		expect(withFooter).toBeCloseTo(withoutFooter + 0.3, 5)
	})
})

describe("estimateElementHeight", () => {
	it("cards grid grows with rows and body length", () => {
		const two: SlideElement = {
			type: "cards",
			cards: [
				{ title: "a", body: "b" },
				{ title: "c", body: "d" },
			],
		}
		const six: SlideElement = {
			type: "cards",
			cards: Array.from({ length: 6 }, (_, i) => ({ title: `t${i}`, body: `body ${i}` })),
		}
		expect(estimateElementHeight(six, 12)).toBeGreaterThan(estimateElementHeight(two, 12))
	})

	it("code cards grow per line", () => {
		const one: SlideElement = { type: "code", lines: ["$ kimchi"] }
		const ten: SlideElement = { type: "code", lines: Array.from({ length: 10 }, (_, i) => `line ${i}`) }
		expect(estimateElementHeight(ten, 12)).toBeGreaterThan(estimateElementHeight(one, 12))
	})
})
