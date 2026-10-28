import { describe, expect, it } from "vitest"
import {
	chartSeriesColors,
	computeSlideLayout,
	estimateElementHeight,
	estimateOverflow,
	mixHex,
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
	it("unset background defaults dark-first with derived light text", () => {
		const pal = resolvePalette({})
		expect(pal.dark).toBe(true)
		expect(pal.bg).toBe("0E0F13")
		expect(pal.text).toBe("FFFFFF")
		expect(pal.muted).toBe("9BA1AB")
		expect(pal.surface).toBe("181A21")
		expect(pal.border).toBe("2A2E39")
		expect(pal.accent).toBe("00A3A1")
		expect(pal.headFont).toBe("Calibri")
		expect(pal.bodyFont).toBe("Calibri")
		expect(pal.monoFont).toBe("Courier New")
	})

	it("explicit light background keeps near-black text, `line` overrides borders", () => {
		const pal = resolvePalette({ background: "#FFFFFF" })
		expect(pal.dark).toBe(false)
		expect(pal.text).toBe("22262B")
		expect(pal.muted).toBe("5A6470")
		expect(pal.surface).toBe("F2F4F6")
		expect(pal.border).toBe("D8DEE4")
		expect(resolvePalette({ background: "#FFFFFF", line: "#FF0000" }).border).toBe("FF0000")
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
		// Centering may shift the stack start down (bounded +0.5") when slack remains.
		expect(ys[0]).toBeGreaterThanOrEqual(1.35)
		expect(ys[0]).toBeLessThanOrEqual(1.86)
		expect(ys[1]).toBeGreaterThan(ys[0])
		expect(ys[2]).toBeGreaterThan(ys[1])
		// Canvas fill: slack goes to the stats row (capped growth) then gaps,
		// so the stack reaches well past its natural height but stays bounded.
		const natural = 1.8
		expect(layout.flow[1].h).toBeGreaterThan(natural)
		expect(layout.flow[1].h).toBeLessThanOrEqual(natural + 0.9 + 0.005) // STRETCH_CAP.stats
		expect(layout.contentBottom).toBeGreaterThan(1.35 + 0.8 * (7.08 - 1.35))
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

describe("chartSeriesColors", () => {
	it("builds an on-brand monochrome ramp anchored on the accent", () => {
		const colors = chartSeriesColors("FF521D", 4)
		expect(colors).toHaveLength(4)
		expect(colors[0]).toBe("FF521D")
		for (const c of colors) expect(c).toMatch(/^[0-9A-F]{6}$/)
		expect(new Set(colors).size).toBeGreaterThan(1) // ramp, not a flat fill
	})

	it("cycles when there are more series than ramp entries", () => {
		const colors = chartSeriesColors("FF521D", 6)
		expect(colors[4]).toBe(colors[0])
		expect(colors[5]).toBe(colors[1])
	})
})

describe("mixHex", () => {
	it("lightens toward white and darkens toward black", () => {
		expect(mixHex("000000", "FFFFFF", 1)).toBe("FFFFFF")
		expect(mixHex("FFFFFF", "000000", 1)).toBe("000000")
		expect(mixHex("808080", "FFFFFF", 0)).toBe("808080")
		const half = mixHex("000000", "FFFFFF", 0.5)
		expect(half).toBe("808080")
	})
})

describe("v5 density fixes", () => {
	it("three cards lay out as a single 3-across row, not a ragged 2x2", () => {
		const three: SlideElement = {
			type: "cards",
			cards: [
				{ title: "a", body: "b" },
				{ title: "c", body: "d" },
				{ title: "e", body: "f" },
			],
		}
		const four: SlideElement = { type: "cards", cards: [...three.cards, { title: "g", body: "h" }] }
		const h3 = estimateElementHeight(three, 12.13)
		const h4 = estimateElementHeight(four, 12.13)
		expect(h3).toBeLessThan(h4) // one row vs two rows
		expect(h3).toBeLessThan(2.0) // single row of cards, no stacked second row
	})

	it("flow descriptions grow the estimated height; plain flows keep the compact one", () => {
		const plain: SlideElement = { type: "flow", stages: [{ label: "a" }, { label: "b" }] }
		const described: SlideElement = {
			type: "flow",
			stages: [
				{ label: "a", description: "every call the agent makes passes through first" },
				{ label: "b", description: "results come back checked and attributed" },
				{ label: "c", description: "output verified before it ships anywhere" },
			],
		}
		expect(estimateElementHeight(plain, 12.13)).toBeCloseTo(1.05)
		// Two-line descriptions at 3-across chip width need a taller band.
		expect(estimateElementHeight(described, 12.13)).toBeGreaterThan(1.15)
	})
})
