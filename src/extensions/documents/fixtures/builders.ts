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

// --- DOCX builders -----------------------------------------------------------

const DOCX_MAIN = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

/**
 * Minimal self-authored DOCX honoring the ground truth its consumers assert:
 * a heading, a plain paragraph, two nested bullets, a tracked insertion and
 * deletion, a commented phrase, and a 2x2 table; side parts for numbering,
 * comments and one footnote are real parts Word would write.
 */
export function makeSimpleDocx(): Promise<Uint8Array> {
	const body = `
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly Report</w:t></w:r></w:p>
<w:p><w:r><w:t>Revenue grew in Q3.</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First bullet</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Nested bullet</w:t></w:r></w:p>
<w:p><w:ins w:id="10" w:author="Alice" w:date="2026-01-01"><w:r><w:t>Inserted sentence.</w:t></w:r></w:ins></w:p>
<w:p><w:del w:id="11" w:author="Bob" w:date="2026-01-02"><w:r><w:delText>Deleted words.</w:delText></w:r></w:del></w:p>
<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Commented phrase</w:t></w:r><w:commentRangeEnd w:id="0"/><w:commentReference w:id="0"/></w:p>
<w:p><w:r><w:t>With footnote</w:t></w:r><w:footnoteReference w:id="1"/></w:p>
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>`
	return makeCustomDocx(body, {
		"word/numbering.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${DOCX_MAIN}">
<w:abstractNum w:abstractNumId="0">
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="\u2022"/></w:lvl>
<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/></w:lvl>
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`,
		"word/comments.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="${DOCX_MAIN}">
<w:comment w:id="0" w:author="Alice" w:date="2026-01-01T10:00:00Z"><w:p><w:r><w:t>Fix this.</w:t></w:r></w:p></w:comment>
</w:comments>`,
		"word/footnotes.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="${DOCX_MAIN}">
<w:footnote w:type="separator" w:id="-1"><w:p/></w:footnote>
<w:footnote w:id="1"><w:p><w:r><w:t>Source: internal data.</w:t></w:r></w:p></w:footnote>
</w:footnotes>`,
		"word/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${DOCX_MAIN}">
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>`,
		"docProps/core.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>Simple fixture</dc:title><dc:creator>kimchi-tests</dc:creator>
</cp:coreProperties>`,
	})
}

/**
 * Root namespace set of a Word 2010+ document.xml (the real producer's
 * shape): the prefixes our own writer never emits, including `mc:Ignorable`.
 * Any parser that hardcodes its own namespace list must work on something
 * shaped like this — see `makeOfficeShapedDocx`.
 */
export const OFFICE_DOCX_ROOT_NS = `xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="${DOCX_MAIN}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" mc:Ignorable="w14 w15 wp14"`

/** Generic DOCX: caller supplies the `w:body` inner XML and any side parts.
 *  `rootAttrs` overrides the `<w:document>` attributes (default: xmlns:w only). */
export function makeCustomDocx(
	bodyInner: string,
	extraParts: Record<string, string> = {},
	opts: { rootAttrs?: string } = {},
): Promise<Uint8Array> {
	const zip = new JSZip()
	zip.file(
		"[Content_Types].xml",
		`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
	)
	zip.file(
		"_rels/.rels",
		`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
	)
	zip.file(
		"word/_rels/document.xml.rels",
		`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdC" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>
  <Relationship Id="rIdF" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
  <Relationship Id="rIdN" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
  <Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
	)
	zip.file(
		"word/document.xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${opts.rootAttrs ?? `xmlns:w="${DOCX_MAIN}"`}><w:body>${bodyInner}<w:sectPr/></w:body></w:document>`,
	)
	for (const [name, content] of Object.entries(extraParts)) zip.file(name, content)
	return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })
}
/**
 * A document shaped like Word 2010+ writes it: the full root namespace set
 * with `mc:Ignorable`, `w14:paraId`/`w14:textId` on paragraphs, and an
 * `mc:AlternateContent` text box (a real producer's output, not a round-trip
 * through our own writer). Ground truth: heading "Board Pack", plain
 * paragraph "Quarterly review.", table (Board|Seats, Custos|12), and the
 * text-box words "text box words".
 */
export function makeOfficeShapedDocx(): Promise<Uint8Array> {
	const body = `
<w:p w14:paraId="3A7B4F2D" w14:textId="10101010"><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Board Pack</w:t></w:r></w:p>
<w:p w14:paraId="11111111" w14:textId="22222222"><w:r><w:t>Quarterly review.</w:t></w:r></w:p>
<w:p w14:paraId="33333333" w14:textId="44444444"><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:inline><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>text box words</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></mc:Choice><mc:Fallback><w:pict/></mc:Fallback></mc:AlternateContent></w:r></w:p>
<w:tbl>
<w:tr><w:tc><w:p w14:paraId="55555555"><w:r><w:t>Board</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Seats</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>Custos</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>`
	return makeCustomDocx(
		body,
		{
			"word/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${DOCX_MAIN}">
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
</w:styles>`,
		},
		{ rootAttrs: OFFICE_DOCX_ROOT_NS },
	)
}

// --- XLSX builders -----------------------------------------------------------

export interface XlsxSheetFixture {
	name: string
	/** Inner XML of the worksheet (rows etc). */
	inner: string
	state?: "hidden" | "veryHidden"
}

/**
 * Minimal self-authored XLSX: two sheets (Data visible, Scratch hidden),
 * shared strings, styles with a custom date numFmt (id 164), formulas with
 * cached values, a boolean, an inline string and a merged range.
 */
export function makeSimpleXlsx(): Promise<Uint8Array> {
	return makeCustomXlsx([
		{
			name: "Data",
			inner: `
<dimension ref="A1:D3"/>
<mergeCells count="1"><mergeCell ref="B4:C4"/></mergeCells>
<sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>2.5</v></c><c r="C1" s="1"><v>45292</v></c><c r="D1"><f>A1&amp;B1</f><v>0</v></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>inline note</t></is></c><c r="B2" t="b"><v>1</v></c><c r="C2" s="1"><v>46022</v></c><c r="D2"><f>SUM(B1:B2)</f><v>1.5</v></c></row>
<row r="3"><c r="A3" t="e"><v>#DIV/0!</v></c><c r="B3"><v>-7</v></c></row>
</sheetData>`,
		},
		{ name: "Scratch", state: "hidden", inner: `<sheetData><row r="1"><c r="A1"><v>99</v></c></row></sheetData>` },
	])
}

/** Custom XLSX from sheet fixtures; styles carry numFmt 164 "yyyy-mm-dd".
 *  `sheetRootAttrs` overrides every `<worksheet>` start tag's attributes. */
export function makeCustomXlsx(
	sheets: XlsxSheetFixture[],
	opts: { date1904?: boolean; sheetRootAttrs?: string } = {},
): Promise<Uint8Array> {
	const zip = new JSZip()
	const M = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
	zip.file(
		"[Content_Types].xml",
		`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `  <Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
</Types>`,
	)
	zip.file(
		"_rels/.rels",
		`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
	)
	zip.file(
		"xl/_rels/workbook.xml.rels",
		`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `  <Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("\n")}
  <Relationship Id="rIdSS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
  <Relationship Id="rIdST" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
	)
	zip.file(
		"xl/workbook.xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${M}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  ${opts.date1904 ? '<workbookPr date1904="1"/>' : ""}
  <sheets>
${sheets.map((s, i) => `    <sheet name="${s.name}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ""} r:id="rId${i + 1}"/>`).join("\n")}
  </sheets>
</workbook>`,
	)
	zip.file(
		"xl/sharedStrings.xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="${M}" count="1" uniqueCount="1"><si><t>padding cell</t></si></sst>`,
	)
	zip.file(
		"xl/styles.xml",
		`<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="${M}">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\\\-mm\\\\-dd"/></numFmts>
  <fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf/></cellStyleXfs>
  <cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs>
</styleSheet>`,
	)
	for (const [i, sh] of sheets.entries()) {
		zip.file(
			`xl/worksheets/sheet${i + 1}.xml`,
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet ${opts.sheetRootAttrs ?? `xmlns="${M}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`}>${sh.inner}</worksheet>`,
		)
	}
	return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })
}

/**
 * Root attribute set Excel 2010+ writes on `<worksheet>`: the default and
 * `r:` namespaces plus `mc:`/`x14ac:`/`xr:`/`xr6:`/`xr10:`/`xr2:`/`xr3:`,
 * `mc:Ignorable` and an `xr:uid`. Rows carry `spans` and `x14ac:dyDescent`.
 * Any parser that hardcodes its own namespace list must work on something
 * shaped like this.
 */
export const OFFICE_XLSX_SHEET_ROOT_ATTRS = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" xmlns:xr6="http://schemas.microsoft.com/office/spreadsheetml/2016/revision6" xmlns:xr10="http://schemas.microsoft.com/office/spreadsheetml/2016/revision10" xmlns:xr2="http://schemas.microsoft.com/office/spreadsheetml/2015/revision2" xmlns:xr3="http://schemas.microsoft.com/office/spreadsheetml/2016/revision3" mc:Ignorable="x14ac xr xr6 xr10" xr:uid="{00000000-0001-0000-0300-000000000000}"`

/**
 * A workbook shaped like Excel 2010+ writes it. Ground truth (sheet "Data"):
 * A1 = shared string "padding cell", B1 = date serial 44927 → "2023-01-01",
 * C1 = formula `A1&amp;B1`, A2 = 2.5, B2 = -7.
 */
export function makeOfficeShapedXlsx(): Promise<Uint8Array> {
	return makeCustomXlsx(
		[
			{
				name: "Data",
				inner: `
<dimension ref="A1:C2"/>
<sheetData>
<row r="1" spans="1:3" x14ac:dyDescent="0.25"><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"><v>44927</v></c><c r="C1"><f>A1&amp;B1</f><v>0</v></c></row>
<row r="2" spans="1:2" x14ac:dyDescent="0.25"><c r="A2"><v>2.5</v></c><c r="B2"><v>-7</v></c></row>
</sheetData>`,
			},
		],
		{ sheetRootAttrs: OFFICE_XLSX_SHEET_ROOT_ATTRS },
	)
}
