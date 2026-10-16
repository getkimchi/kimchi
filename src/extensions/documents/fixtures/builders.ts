/**
 * Shared in-memory fixture builders for the document extractors.
 * Every fixture is self-authored (no license concerns) with known ground truth.
 * PDF and DOCX builders land with the Phase 1 extraction branch.
 */

import JSZip from "jszip"

export async function makeSimplePptx(): Promise<Uint8Array> {
	const zip = new JSZip()
	zip.file(
		"[Content_Types].xml",
		`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide3.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>
</Types>`,
	)
	zip.file(
		"ppt/_rels/presentation.xml.rels",
		`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide3.xml"/>
</Relationships>`,
	)
	zip.file(
		"ppt/presentation.xml",
		`<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId1"/>
    <p:sldId id="257" r:id="rId3"/>
    <p:sldId id="258" r:id="rId2" show="0"/>
  </p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`,
	)
	const slideWrap = (inner: string) =>
		`<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr/><p:grpSpPr/>
    ${inner}
  </p:spTree></p:cSld>
</p:sld>`
	const textShape = (name: string, text: string) => `
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr/>
      <p:txBody>
        <a:bodyPr/><a:lstStyle/>
        <a:p><a:r><a:t>${text}</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>`
	zip.file("ppt/slides/slide1.xml", slideWrap(textShape("Title 1", "Kickoff") + textShape("Body 1", "Agenda items")))
	const tableShape = `
    <p:graphicFrame>
      <p:nvGraphicFramePr><p:cNvPr id="3" name="Table 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
        <a:tbl>
          <a:tr h="1"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>H1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>H2</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
          <a:tr h="1"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>C1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>C2</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
        </a:tbl>
      </a:graphicData></a:graphic>
    </p:graphicFrame>`
	zip.file("ppt/slides/slide2.xml", slideWrap(tableShape))
	zip.file("ppt/slides/slide2.xml.rels", "") // placeholder, overwritten below
	zip.file("ppt/slides/slide3.xml", slideWrap(textShape("Body 1", "Closing remarks")))
	zip.file(
		"ppt/slides/_rels/slide2.xml.rels",
		`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
	)
	zip.file(
		"ppt/slides/_rels/slide3.xml.rels",
		`<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
</Relationships>`,
	)
	zip.file(
		"ppt/notesSlides/notesSlide1.xml",
		`<?xml version="1.0"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr/><p:grpSpPr/>
    ${textShape("Notes Placeholder", "Remember to thank sponsors")}
  </p:spTree></p:cSld>
</p:notes>`,
	)
	zip.remove("ppt/slides/slide2.xml.rels")
	return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })
}

const DEFAULT_SLD_SZ = `<p:sldSz cx="9144000" cy="6858000"/>`

function oneSlidePptx(slideInner: string, extraParts?: Record<string, string>): JSZip {
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
  ${DEFAULT_SLD_SZ}
</p:presentation>`,
	)
	zip.file(
		"ppt/slides/slide1.xml",
		`<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr/><p:grpSpPr/>
    ${slideInner}
  </p:spTree></p:cSld>
</p:sld>`,
	)
	for (const [name, content] of Object.entries(extraParts ?? {})) zip.file(name, content)
	return zip
}

/** Shape with an explicit position/size and optional font size/alt text. */
export function xfrmShapeXml(opts: {
	name: string
	text: string
	x?: number
	y?: number
	cx: number
	cy: number
	fontSz?: number
	placeholder?: string
}): string {
	const sz = opts.fontSz ? ` sz="${opts.fontSz}"` : ""
	const ph = opts.placeholder ? `<p:nvPr><p:ph ${opts.placeholder}/></p:nvPr>` : "<p:nvPr/>"
	return `
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="${opts.name}"/><p:cNvSpPr/>${ph}</p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="${opts.x ?? 0}" y="${opts.y ?? 0}"/><a:ext cx="${opts.cx}" cy="${opts.cy}"/></a:xfrm>
      </p:spPr>
      <p:txBody>
        <a:bodyPr/><a:lstStyle/>
        <a:p><a:r><a:rPr${sz}/><a:t>${opts.text}</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>`
}

/**
 * Seeded-defect deck: one tiny box with far too much text, a picture without
 * alt text, a shape running off the slide, and a clean hero shape that must
 * stay silent.
 */
export async function makeDefectivePptx(): Promise<Uint8Array> {
	const overflow = xfrmShapeXml({
		name: "Body Overflow",
		text: Array.from({ length: 40 }, (_, i) => `detail line ${i + 1} of the quarter review narrative`).join(" "),
		cx: 914400, // 1" wide
		cy: 457200, // 0.5" tall
		fontSz: 2400,
	})
	const hero = xfrmShapeXml({ name: "Hero", text: "Q3", cx: 4572000, cy: 914400, fontSz: 4000 })
	const picture = `
    <p:pic>
      <p:nvPicPr><p:cNvPr id="4" name="Picture 4"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
      <p:blipFill/><p:spPr/>
    </p:pic>`
	const offSlide = xfrmShapeXml({ name: "Off Edge", text: "cut off", x: 9000000, cx: 914400, cy: 457200 })
	return oneSlidePptx(overflow + hero + picture + offSlide).generateAsync({
		type: "uint8array",
		compression: "DEFLATE",
	})
}

/** Clean deck with a named layout and placeholder shapes for inspect tests. */
export async function makeTemplatedPptx(): Promise<Uint8Array> {
	const title = xfrmShapeXml({
		name: "Title 1",
		text: "Kickoff",
		cx: 8000000,
		cy: 1000000,
		placeholder: 'type="title"',
	})
	const body = xfrmShapeXml({
		name: "Content Placeholder 2",
		text: "Bullet one\nBullet two",
		cx: 8000000,
		cy: 4000000,
		y: 1200000,
		placeholder: 'type="body" idx="1"',
	})
	const layoutXml = `<?xml version="1.0" encoding="UTF-8"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld name="Title and Content"><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title Placeholder"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:cNvPr id="3" name="Body Placeholder"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sldLayout>`
	const slideRels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`
	return oneSlidePptx(title + body, {
		"ppt/slideLayouts/slideLayout1.xml": layoutXml,
		"ppt/slides/_rels/slide1.xml.rels": slideRels,
	}).generateAsync({ type: "uint8array", compression: "DEFLATE" })
}
