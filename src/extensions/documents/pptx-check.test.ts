import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import { makeDefectivePptx, makeSimplePptx, makeTemplatedPptx } from "./fixtures/builders.js"
import { checkPptx, renderFindings } from "./pptx-check.js"

describe("checkPptx", () => {
	it("flags likely text overflow in a tiny box with long text (heuristic: 0.5 x font width, 1.05 tolerance)", async () => {
		const findings = await checkPptx(await makeDefectivePptx())
		const overflow = findings.find((f) => f.kind === "text-overflow")
		expect(overflow).toMatchObject({ slide: 1, shape: "Body Overflow" })
		expect(overflow?.detail).toContain("likely text overflow")
	})

	it("flags a picture without alt text", async () => {
		const findings = await checkPptx(await makeDefectivePptx())
		expect(findings.some((f) => f.kind === "missing-alt-text" && f.shape === "Picture 4")).toBe(true)
	})

	it("flags a shape extending past the slide bbox", async () => {
		const findings = await checkPptx(await makeDefectivePptx())
		expect(findings.some((f) => f.kind === "off-slide" && f.shape === "Off Edge")).toBe(true)
	})

	it("stays silent on a correctly sized hero shape (false-positive guard)", async () => {
		const findings = await checkPptx(await makeDefectivePptx())
		expect(findings.some((f) => f.shape === "Hero")).toBe(false)
	})

	it("stays silent on clean decks", async () => {
		expect(await checkPptx(await makeTemplatedPptx())).toEqual([])
		expect(await checkPptx(await makeSimplePptx())).toEqual([])
	})

	it("renders findings as locator-carrying lines", async () => {
		const findings = await checkPptx(await makeDefectivePptx())
		const text = renderFindings(findings)
		expect(text).toContain('slide 1 [shape "Body Overflow"] text-overflow: likely text overflow')
		expect(renderFindings([])).toBe("no findings")
	})
})

/* -------------------- synthetic decks for the newer rules -------------------- */

const PT = 12700 // EMU per point
const SLIDE_W = 12192000 // 13.33" in EMU
const SLIDE_H = 6858000 // 7.5" in EMU

function textSp(opts: {
	id: number
	name: string
	text: string
	x: number
	y: number
	w: number
	h: number
	color?: string
}): string {
	const rPr = opts.color
		? `<a:rPr lang="en-US" sz="1200"><a:solidFill><a:srgbClr val="${opts.color}"/></a:solidFill></a:rPr>`
		: `<a:rPr lang="en-US" sz="1200"/>`
	return `<p:sp>
  <p:nvSpPr><p:cNvPr id="${opts.id}" name="${opts.name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="${opts.x}" y="${opts.y}"/><a:ext cx="${opts.w}" cy="${opts.h}"/></a:xfrm></p:spPr>
  <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r>${rPr}<a:t>${opts.text}</a:t></a:r></a:p></p:txBody>
</p:sp>`
}

async function deckWith(slides: Array<{ inner: string; bg?: string }>): Promise<Uint8Array> {
	const zip = new JSZip()
	const overrides = slides
		.map(
			(_, i) =>
				`<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
		)
		.join("")
	zip.file(
		"[Content_Types].xml",
		`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  ${overrides}
</Types>`,
	)
	const rels = slides
		.map(
			(_, i) =>
				`<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
		)
		.join("")
	zip.file(
		"ppt/_rels/presentation.xml.rels",
		`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
	)
	const sldIds = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("")
	zip.file(
		"ppt/presentation.xml",
		`<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/officeDocument/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>${sldIds}</p:sldIdLst>
  <p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/>
</p:presentation>`,
	)
	slides.forEach((sl, i) => {
		const bg = sl.bg
			? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${sl.bg}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
			: ""
		zip.file(
			`ppt/slides/slide${i + 1}.xml`,
			`<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>${bg}<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${sl.inner}</p:spTree></p:cSld>
</p:sld>`,
		)
	})
	return new Uint8Array(await zip.generateAsync({ type: "nodebuffer" }))
}

describe("overlap findings", () => {
	it("flags two text shapes whose boxes intersect meaningfully", async () => {
		const deck = await deckWith([
			{
				inner:
					textSp({ id: 2, name: "Title 1", text: "Heading", x: 72 * PT, y: 72 * PT, w: 400 * PT, h: 100 * PT }) +
					textSp({ id: 3, name: "Body 1", text: "Content", x: 90 * PT, y: 120 * PT, w: 400 * PT, h: 120 * PT }),
			},
		])
		const findings = await checkPptx(deck)
		const overlap = findings.find((f) => f.kind === "overlap")
		expect(overlap).toMatchObject({ slide: 1, shape: "Title 1" })
		expect(overlap?.detail).toContain('likely overlaps "Body 1"')
	})

	it("stays silent when boxes only touch at edges or one box has no text", async () => {
		const deck = await deckWith([
			{
				inner:
					textSp({ id: 2, name: "Title 1", text: "Heading", x: 72 * PT, y: 72 * PT, w: 400 * PT, h: 80 * PT }) +
					textSp({ id: 3, name: "Body 1", text: "Content", x: 72 * PT, y: 158 * PT, w: 400 * PT, h: 300 * PT }),
			},
		])
		expect((await checkPptx(deck)).filter((f) => f.kind === "overlap")).toEqual([])
	})
})

describe("low-contrast findings", () => {
	it("flags dark and uncolored text on a dark background, stays silent on light text", async () => {
		const deck = await deckWith([
			{
				bg: "0E0F13",
				inner:
					textSp({
						id: 2,
						name: "Dark Text",
						text: "hidden",
						x: 72 * PT,
						y: 72 * PT,
						w: 300 * PT,
						h: 90 * PT,
						color: "222222",
					}) +
					textSp({ id: 3, name: "Uncolored", text: "inherits", x: 72 * PT, y: 270 * PT, w: 300 * PT, h: 90 * PT }) +
					textSp({
						id: 4,
						name: "Light Text",
						text: "visible",
						x: 72 * PT,
						y: 460 * PT,
						w: 300 * PT,
						h: 60 * PT,
						color: "FFFFFF",
					}),
			},
		])
		const findings = await checkPptx(deck)
		const contrast = findings.filter((f) => f.kind === "low-contrast").map((f) => f.shape)
		expect(contrast).toContain("Dark Text")
		expect(contrast).toContain("Uncolored")
		expect(contrast).not.toContain("Light Text")
	})

	it("never flags on a light background", async () => {
		const deck = await deckWith([
			{
				bg: "FFFFFF",
				inner: textSp({
					id: 2,
					name: "T",
					text: "x",
					x: 72 * PT,
					y: 72 * PT,
					w: 300 * PT,
					h: 200 * PT,
					color: "222222",
				}),
			},
		])
		expect((await checkPptx(deck)).filter((f) => f.kind === "low-contrast")).toEqual([])
	})
})

describe("dead-space findings", () => {
	it("flags a slide whose content clumps in the top half", async () => {
		const deck = await deckWith([
			{
				inner:
					textSp({ id: 2, name: "Title", text: "Heading", x: 43 * PT, y: 25 * PT, w: 800 * PT, h: 90 * PT }) +
					textSp({ id: 3, name: "Body", text: "Two short lines", x: 43 * PT, y: 130 * PT, w: 800 * PT, h: 110 * PT }),
			},
		])
		const findings = await checkPptx(deck)
		const dead = findings.find((f) => f.kind === "dead-space")
		expect(dead).toMatchObject({ slide: 1 })
		expect(dead?.detail).toContain("% of the slide height")
	})

	it("stays silent when content spans the canvas", async () => {
		const deck = await deckWith([
			{
				inner:
					textSp({ id: 2, name: "Title", text: "Heading", x: 43 * PT, y: 25 * PT, w: 800 * PT, h: 90 * PT }) +
					textSp({ id: 3, name: "Body", text: "Content", x: 43 * PT, y: 420 * PT, w: 800 * PT, h: 80 * PT }),
			},
		])
		expect((await checkPptx(deck)).filter((f) => f.kind === "dead-space")).toEqual([])
	})
})

describe("monotony findings", () => {
	const plainSlide = (i: number) => ({
		inner:
			textSp({ id: 2, name: "Title", text: `Slide ${i}`, x: 43 * PT, y: 25 * PT, w: 800 * PT, h: 90 * PT }) +
			textSp({ id: 3, name: "Body", text: `Bullets ${i}`, x: 43 * PT, y: 135 * PT, w: 800 * PT, h: 300 * PT }),
	})

	it("flags decks where most slides are title-and-text only", async () => {
		const deck = await deckWith([0, 1, 2, 3, 4, 5, 6, 7].map(plainSlide))
		const findings = await checkPptx(deck)
		const monotony = findings.find((f) => f.kind === "monotony")
		expect(monotony).toMatchObject({ slide: 0 })
		expect(monotony?.detail).toContain("8 of 8 slides")
	})

	it("stays silent on varied decks and small decks", async () => {
		const small = await deckWith([0, 1, 2].map(plainSlide))
		expect((await checkPptx(small)).filter((f) => f.kind === "monotony")).toEqual([])
		// Varied: two of eight slides carry a table and a card stack — not all the same shape.
		const withVariety = await deckWith([
			...[0, 1, 2, 3, 4, 5].map(plainSlide),
			{
				inner: `<p:graphicFrame>
  <p:nvGraphicFramePr><p:cNvPr id="3" name="Table 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
  <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
    <a:tbl><a:tr h="1"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>H</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl>
  </a:graphicData></a:graphic>
</p:graphicFrame>`,
			},
			{
				inner:
					textSp({ id: 2, name: "A", text: "one", x: 43 * PT, y: 25 * PT, w: 200 * PT, h: 50 * PT }) +
					textSp({ id: 3, name: "B", text: "two", x: 43 * PT, y: 90 * PT, w: 200 * PT, h: 50 * PT }) +
					textSp({ id: 4, name: "C", text: "three", x: 43 * PT, y: 155 * PT, w: 200 * PT, h: 50 * PT }),
			},
		])
		expect((await checkPptx(withVariety)).filter((f) => f.kind === "monotony")).toEqual([])
	})
})
