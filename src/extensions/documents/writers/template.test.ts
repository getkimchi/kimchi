import { describe, expect, it } from "vitest"
import { extractPptx } from "../extractors/pptx.js"
import { openOoxml } from "../ooxml/package.js"
import { byTag } from "../ooxml/xml.js"
import { parseDeckMarkdown } from "./pptx.js"
import { createFromTemplate, listTemplateLayouts, pickLayout, relativeTarget } from "./template.js"

/** A plausible company template: two layouts (Title Slide, Title and Content). */
function makeTemplate(): Promise<Uint8Array> {
	return openJZipTemplate()
}

async function openJZipTemplate(): Promise<Uint8Array> {
	const { default: JSZip } = await import("jszip")
	const zip = new JSZip()
	zip.file(
		"[Content_Types].xml",
		`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
</Types>`,
	)
	zip.file(
		"ppt/_rels/presentation.xml.rels",
		`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`,
	)
	zip.file(
		"ppt/presentation.xml",
		`<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000"/>
</p:presentation>`,
	)
	const layout = (name: string, phs: string) =>
		`<?xml version="1.0" encoding="UTF-8"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld name="${name}"><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
    ${phs}
  </p:spTree></p:cSld>
</p:sldLayout>`
	zip.file(
		"ppt/slideLayouts/slideLayout1.xml",
		layout(
			"Title Slide",
			`<p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp>`,
		),
	)
	zip.file(
		"ppt/slideLayouts/slideLayout2.xml",
		layout(
			"Title and Content",
			`<p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp>
     <p:sp><p:nvSpPr><p:cNvPr id="3" name="b"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp>`,
		),
	)
	zip.file(
		"ppt/slides/slide1.xml",
		`<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Old"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Old cover</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`,
	)
	zip.file(
		"ppt/slides/_rels/slide1.xml.rels",
		`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
	)
	return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })
}

describe("template layouts", () => {
	it("lists layouts by name with placeholder inventory", async () => {
		const pkg = await openOoxml(await makeTemplate())
		const layouts = listTemplateLayouts(pkg)
		expect(layouts.map((l) => l.name)).toEqual(["Title Slide", "Title and Content"])
		expect(layouts[1].placeholders).toEqual([
			{ type: "title", idx: 0 },
			{ type: "body", idx: 1 },
		])
	})

	it("picks by name then by structure", async () => {
		const pkg = await openOoxml(await makeTemplate())
		const layouts = listTemplateLayouts(pkg)
		expect(pickLayout(layouts, "title", 1).name).toBe("Title Slide")
		expect(pickLayout(layouts, "content", 1).name).toBe("Title and Content")
		expect(() => pickLayout(layouts, "two-column", 3)).toThrow(/slide 3: no template layout matches "two-column"/)
	})
})

describe("createFromTemplate", () => {
	it("keeps the template package and adds slides in sldIdLst order with layout inheritance", async () => {
		const spec = parseDeckMarkdown("# Cover :: title\n\n---\n# Agenda :: content\n\n- one\n- two\n")
		const bytes = await createFromTemplate(spec, await makeTemplate())
		const doc = await extractPptx(bytes)
		expect(doc.units).toHaveLength(2)
		expect(doc.units[0].markdown).toContain("Cover")
		expect(doc.units[1].markdown).toContain("one")
		// The template's old slide must not appear.
		expect(JSON.stringify(doc)).not.toContain("Old cover")
		// New slides reference the template layouts through rels.
		const pkg = await openOoxml(bytes)
		const rels = pkg.getXml("ppt/slides/_rels/slide2.xml.rels")
		const targets = byTag(rels, "Relationship").map((el) => el.getAttribute("Target"))
		expect(targets).toContain("../slideLayouts/slideLayout1.xml")
		const rels2 = pkg.getXml("ppt/slides/_rels/slide3.xml.rels")
		expect(byTag(rels2, "Relationship").map((el) => el.getAttribute("Target"))).toContain(
			"../slideLayouts/slideLayout2.xml",
		)
	})

	it("errors on charts/images in template mode", async () => {
		const spec = parseDeckMarkdown('# A\n\n```chart\n{"type":"bar","labels":["Q"],"series":[{"values":[1]}]}\n```\n')
		await expect(createFromTemplate(spec, await makeTemplate())).rejects.toMatchObject({ code: "unsupported-format" })
	})

	// Regression: the body fill loop used to pour elements into EVERY
	// non-title placeholder (including picture placeholders — text in a pic ph
	// renders as an empty image box) and silently dropped elements once the
	// placeholders ran out. Now only body/untyped placeholders are filled and
	// overflow concatenates into the last used one, so nothing is lost.
	it("never fills picture placeholders and never drops overflow content", async () => {
		const { default: JSZip } = await import("jszip")
		const zip = new JSZip()
		zip.file(
			"[Content_Types].xml",
			`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
</Types>`,
		)
		zip.file(
			"ppt/_rels/presentation.xml.rels",
			`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`,
		)
		zip.file(
			"ppt/presentation.xml",
			`<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000"/>
</p:presentation>`,
		)
		// One text placeholder, one picture placeholder — content must overflow
		// into the text one and never touch the picture one.
		zip.file(
			"ppt/slideLayouts/slideLayout1.xml",
			`<?xml version="1.0" encoding="UTF-8"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld name="Pic Layout"><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:cNvPr id="3" name="p"/><p:cNvSpPr/><p:nvPr><p:ph type="pic" idx="5"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:cNvPr id="4" name="b"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sldLayout>`,
		)
		zip.file(
			"ppt/slides/slide1.xml",
			`<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/></p:spTree></p:cSld>
</p:sld>`,
		)
		zip.file(
			"ppt/slides/_rels/slide1.xml.rels",
			`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
		)
		const template = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })

		const spec = parseDeckMarkdown("# Cover\n\npara one\n\npara two\n\npara three\n\n- bullet a\n- bullet b\n")
		const bytes = await createFromTemplate(spec, template)
		const pkg = await openOoxml(bytes)
		const slide = pkg.getXml("ppt/slides/slide2.xml")
		const texts = byTag(slide, "t").map((el) => el.textContent ?? "")
		// Nothing dropped: every paragraph and bullet made it onto the slide.
		for (const expected of ["Cover", "para one", "para two", "para three", "bullet a", "bullet b"]) {
			expect(texts).toContain(expected)
		}
		// The picture placeholder was never filled with text.
		const phs = byTag(slide, "ph").map((el) => el.getAttribute("type"))
		expect(phs).not.toContain("pic")
	})

	it("promotes a leading sub-heading to the slide title", async () => {
		// No `#` heading: the first `##` is the title, not a stray bold line.
		const spec = parseDeckMarkdown("## What we verify\n\nbody text\n")
		const bytes = await createFromTemplate(spec, await makeTemplate())
		const pkg = await openOoxml(bytes)
		const slide = pkg.getXml("ppt/slides/slide2.xml")
		const titleShape = byTag(slide, "sp").find((sp) =>
			byTag(sp, "ph").some((ph) => ph.getAttribute("type") === "title"),
		)
		expect(titleShape).toBeDefined()
		const titleText =
			titleShape === undefined
				? ""
				: byTag(titleShape, "t")
						.map((el) => el.textContent ?? "")
						.join("")
		expect(titleText).toBe("What we verify")
	})
})

describe("relativeTarget", () => {
	it("walks between sibling dirs", () => {
		expect(relativeTarget("ppt/slides", "ppt/slideLayouts/slideLayout1.xml")).toBe("../slideLayouts/slideLayout1.xml")
		expect(relativeTarget("ppt", "ppt/slides/slide3.xml")).toBe("slides/slide3.xml")
	})
})
