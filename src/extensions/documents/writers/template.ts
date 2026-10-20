/**
 * Template-mode deck creation: appends fresh slides to an existing company
 * template, keeping its masters, layouts and theme intact. Each requested
 * layout hint is matched to a template layout by its placeholder inventory
 * (not only its name), and the new slide carries a `<p:ph>` shape per
 * placeholder with the markdown content — geometry/formatting come from the
 * layout via inheritance, so company templates keep their look.
 *
 * Charts and images are not supported in template mode yet: they need parts
 * (chart XML, media) that cloning the layout placeholder pattern doesn't
 * produce, so they are a typed error here and supported in plain create.
 */

import { ooxmlPartDir, ooxmlRelsPath } from "../extractors/pptx.js"
import { DocumentError } from "../model.js"
import { type OoxmlPackage, openOoxml } from "../ooxml/package.js"
import { byTag, parseXml } from "../ooxml/xml.js"
import type { DeckSpec, LayoutHint, SlideSpec } from "./pptx-model.js"

export interface TemplateLayout {
	path: string
	name: string
	/** Placeholder types present, with their idx values. */
	placeholders: Array<{ type: string; idx: number }>
}

/** Read the template's slide layouts with their placeholders. */
export function listTemplateLayouts(pkg: OoxmlPackage): TemplateLayout[] {
	const layouts: TemplateLayout[] = []
	for (const name of pkg.names()) {
		if (!/^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name)) continue
		const layout = pkg.getXml(name)
		let layoutName = name
		for (const cSld of byTag(layout, "cSld")) {
			layoutName = cSld.getAttribute("name") ?? name
			break
		}
		const placeholders: TemplateLayout["placeholders"] = []
		for (const ph of byTag(layout, "ph")) {
			const type = ph.getAttribute("type") ?? "body"
			const idx = Number(ph.getAttribute("idx") ?? 0)
			placeholders.push({ type, idx })
		}
		layouts.push({ path: name, name: layoutName, placeholders })
	}
	return layouts
}

/** Best layout for a hint: exact-ish placeholder inventory match by name then by structure. */
export function pickLayout(layouts: TemplateLayout[], hint: LayoutHint | undefined, slideNo: number): TemplateLayout {
	const wantsTitle = (l: TemplateLayout) => l.placeholders.some((p) => p.type === "title" || p.type === "ctrTitle")
	const bodies = (l: TemplateLayout) => l.placeholders.filter((p) => p.type === "body" || p.type === undefined)
	const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ")
	const byName = (pat: RegExp) => layouts.find((l) => pat.test(normalize(l.name)))

	switch (hint ?? "content") {
		case "title": {
			return byName(/title/) ?? layouts.find(wantsTitle) ?? fail("title", slideNo, layouts)
		}
		case "two-column": {
			return (
				byName(/two|column|comparison/) ??
				layouts.find((l) => bodies(l).length >= 2) ??
				fail("two-column", slideNo, layouts)
			)
		}
		case "blank":
			return byName(/blank/) ?? layouts.find((l) => l.placeholders.length === 0) ?? fail("blank", slideNo, layouts)
		case "table":
		case "chart":
		case "content":
		default: {
			return (
				byName(/content|body|title and/) ??
				layouts.find((l) => wantsTitle(l) && bodies(l).length >= 1) ??
				fail("content", slideNo, layouts)
			)
		}
	}
}

/** Exact (case/space-insensitive) layout-name lookup — the vocabulary `inspect` prints. */
export function pickLayoutByName(layouts: TemplateLayout[], name: string, slideNo?: number): TemplateLayout {
	const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()
	const match = layouts.find((l) => normalize(l.name) === normalize(name))
	if (match) return match
	throw new DocumentError(
		"corrupt",
		`no layout named "${name}" in the deck (layouts: ${layouts.map((l) => `"${l.name}"`).join(", ") || "none"})${slideNo !== undefined ? ` — slide ${slideNo}` : ""}; run \`inspect\` for exact names`,
	)
}

/** Plain textbox shape (geometry matching the writer's defaults) — the no-placeholder fallback. */
function freeFormTextShape(name: string, inner: string, id: number): string {
	return `<p:sp>
      <p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="457200" y="274320"/><a:ext cx="8229600" cy="914400"/></a:xfrm>
      </p:spPr>
      <p:txBody><a:bodyPr/><a:lstStyle/>${inner}</p:txBody>
    </p:sp>`
}

function fail(hint: string, slideNo: number, layouts: TemplateLayout[]): never {
	throw new DocumentError(
		"corrupt",
		`slide ${slideNo}: no template layout matches "${hint}" (layouts: ${layouts.map((l) => `"${l.name}"`).join(", ")})`,
	)
}

const XMLNS = {
	a: "http://schemas.openxmlformats.org/drawingml/2006/main",
	p: "http://schemas.openxmlformats.org/presentationml/2006/main",
	r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}

/** Build the slide XML for a spec slide on a layout: ph shapes carry text. */
function buildSlideXml(slide: SlideSpec, layout: TemplateLayout): string {
	const shapeText: string[] = []
	const elements = [...slide.elements]
	const titlePh = layout.placeholders.find((p) => p.type === "title" || p.type === "ctrTitle")
	// A leading `##` heading acts as the slide title when the markdown used no
	// explicit `#` heading — otherwise it would fall into the body stream and
	// read as a stray bold line under a missing title.
	if (slide.heading === undefined && elements[0]?.type === "heading") {
		const promoted = elements.shift()
		if (promoted?.type === "heading") slide.heading = promoted.inline.map((i) => i.text).join("")
	}
	if (slide.heading && titlePh) {
		shapeText.push(phShape(titlePh, `<a:p><a:r><a:t>${escapeXml(slide.heading)}</a:t></a:r></a:p>`, 2))
	} else if (slide.heading) {
		// Layouts with no placeholders (e.g. created decks' bare layouts): fall
		// back to a free-form text box at the standard writer position so the
		// title is still visible and editable.
		shapeText.push(
			freeFormTextShape(
				"Text 0",
				`<a:p><a:r><a:rPr lang="en-US" b="1"/><a:t>${escapeXml(slide.heading)}</a:t></a:r></a:p>`,
				2,
			),
		)
	}
	// Fill text placeholders only (body type or untyped). Picture/table/chart
	// placeholders would render the text invisibly or corrupt on save, and a
	// layout can legitimately have fewer text slots than the slide has content
	// blocks — overflow concatenates into the last used placeholder instead of
	// being dropped, so template mode never loses content silently.
	const textPlaceholders = layout.placeholders.filter((p) => p.type === "body" || p.type === undefined)
	let bodySlot = 0
	for (const element of elements) {
		const bodyXml = elementBodyXml(element)
		if (bodyXml === "") continue
		if (bodySlot < textPlaceholders.length) {
			const ph = textPlaceholders[bodySlot]
			shapeText.push(phShape(ph, bodyXml, 3 + bodySlot + 1))
		} else if (textPlaceholders.length > 0) {
			const ph = textPlaceholders[textPlaceholders.length - 1]
			const last = shapeText[shapeText.length - 1]
			if (last !== undefined && last.includes(`idx="${ph.idx}"`)) {
				shapeText[shapeText.length - 1] = last.replace("</p:txBody>", `${bodyXml}</p:txBody>`)
			} else {
				shapeText.push(phShape(ph, bodyXml, 3 + bodySlot + 1))
			}
		} else {
			// Layout has no text placeholders: free-form text boxes keep the
			// content visible and editable (same fallback as the title above).
			shapeText.push(freeFormTextShape(`Text ${bodySlot}`, bodyXml, 3 + bodySlot))
		}
		bodySlot++
	}
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="${XMLNS.a}" xmlns:p="${XMLNS.p}" xmlns:r="${XMLNS.r}">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    ${shapeText.join("\n    ")}
  </p:spTree></p:cSld>
</p:sld>`
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/** Text runs for one body element, with bullet paragraph breaks. */
function elementBodyXml(element: NonNullable<SlideSpec["elements"][number]>): string {
	const run = (text: string, bold = false) => {
		const rPr = bold ? `<a:rPr lang="en-US" b="1"/>` : ""
		return `<a:p><a:r>${rPr}<a:t>${escapeXml(text)}</a:t></a:r></a:p>`
	}
	switch (element.type) {
		case "heading":
			// Sub-headings inside the body stream render as bold paragraphs —
			// dropping them silently lost real user content.
			return run(element.inline.map((i) => i.text).join(""), true)
		case "bullets": {
			const lines: string[] = []
			const walk = (items: typeof element.items, depth: number) => {
				for (const item of items) {
					const indent = depth > 0 ? `<a:pPr lvl="${Math.min(depth, 4)}"/>` : ""
					lines.push(`<a:p>${indent}<a:r><a:t>${escapeXml(item.inline.map((i) => i.text).join(""))}</a:t></a:r></a:p>`)
					for (const child of item.children) if (child.type === "bullets") walk(child.items, depth + 1)
				}
			}
			walk(element.items, 0)
			return lines.join("")
		}
		case "paragraphs":
			return element.inline.map((p) => run(p.map((i) => i.text).join(""))).join("")
		case "table": {
			const rows = [element.header, ...element.rows].map((r) => r.map((c) => c.map((i) => i.text).join("")).join(" | "))
			return rows.map((r) => run(r)).join("")
		}
		default:
			return ""
	}
}

function phShape(ph: { type: string; idx: number }, inner: string, id: number): string {
	const typeAttr = ph.type === "body" ? "" : ` type="${ph.type}"`
	const idxAttr = ph.idx ? ` idx="${ph.idx}"` : ""
	return `<p:sp>
      <p:nvSpPr>
        <p:cNvPr id="${id}" name=""/>
        <p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>
        <p:nvPr><p:ph${typeAttr}${idxAttr}/></p:nvPr>
      </p:nvSpPr>
      <p:spPr/>
      <p:txBody>
        <a:bodyPr/>
        <a:lstStyle/>
        ${inner}
      </p:txBody>
    </p:sp>`
}

/** Append the spec's slides to the template package, returning the new bytes. */
export async function createFromTemplate(spec: DeckSpec, templateBytes: Uint8Array): Promise<Uint8Array> {
	const pkg = await openOoxml(templateBytes)
	if (!pkg.hasXml("ppt/presentation.xml")) throw new DocumentError("corrupt", "Not a PPTX template.")
	const layouts = listTemplateLayouts(pkg)
	if (layouts.length === 0) throw new DocumentError("corrupt", "Template has no slide layouts.")

	for (const slide of spec.slides) {
		if (slide.elements.some((e) => e.type === "chart" || e.type === "image")) {
			throw new DocumentError(
				"unsupported-format",
				`slide ${slide.index}: charts and images aren't supported in template mode yet — create without --template first`,
			)
		}
	}

	// Remove existing sldId entries (the template's slides go away; their
	// parts stay in the package harmlessly — PowerPoint ignores unlisted slides).
	const presentation = pkg.getXml("ppt/presentation.xml")
	for (const sldId of byTag(presentation, "sldId")) {
		sldId.parentNode?.removeChild(sldId)
	}
	pkg.putXml("ppt/presentation.xml", presentation)

	appendSlides(pkg, spec.slides, layouts)
	return pkg.save()
}

/**
 * Append slides to a TEMPLATE-STYLE package: each new slide is created
 * against the template's own layouts and wired into presentation.xml, its
 * rels, and [Content_Types].xml. Numbering (slide part ids, rIds, sldId
 * ids) continues from the package's existing maxima. Shared by the template
 * create path and the editor's append_slide op.
 */
export function appendSlides(pkg: OoxmlPackage, slides: SlideSpec[], layouts: TemplateLayout[]): void {
	if (layouts.length === 0) {
		throw new DocumentError("corrupt", "Deck has no slide layouts — cannot append slides.")
	}
	const existing = pkg
		.names()
		.map((n) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(n)?.[1])
		.filter((n): n is string => n !== undefined)
		.map(Number)
	let nextId = existing.length === 0 ? 1 : Math.max(...existing) + 1

	const presentation = pkg.getXml("ppt/presentation.xml")
	const presRelsPath = ooxmlRelsPath("ppt/presentation.xml")
	const presRels = pkg.getXml(presRelsPath)
	const usedRids = byTag(presRels, "Relationship")
		.map((el) => el.getAttribute("Id") ?? "")
		.filter((id) => /^rId\d+$/.test(id))
		.map((id) => Number(id.slice(3)))
	let nextRid = usedRids.length === 0 ? 1 : Math.max(...usedRids) + 1
	const usedSldIds = byTag(presentation, "sldId")
		.map((el) => Number(el.getAttribute("id")))
		.filter((n) => Number.isFinite(n))
	let nextSldId = usedSldIds.length === 0 ? 256 : Math.max(...usedSldIds) + 1

	const contentTypes = pkg.getXml("[Content_Types].xml")

	for (const slide of slides) {
		const layout = slide.layoutName
			? pickLayoutByName(layouts, slide.layoutName, slide.index)
			: pickLayout(layouts, slide.layoutHint, slide.index)
		const slidePath = `ppt/slides/slide${nextId++}.xml`
		const rid = `rId${nextRid++}`
		const sldIdValue = nextSldId++

		pkg.putXml(slidePath, parseXml(buildSlideXml(slide, layout)))
		pkg.putXml(
			ooxmlRelsPath(slidePath),
			parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="${relativeTarget(ooxmlPartDir(slidePath), layout.path)}"/>
</Relationships>`),
		)

		// presentation.xml: append sldId with new rId.
		const sldIdLst = byTag(presentation, "sldIdLst")[0]
		if (!sldIdLst) throw new DocumentError("corrupt", "Template presentation.xml has no sldIdLst.")
		const sldIdEl = presentation.createElementNS(XMLNS.p, "p:sldId")
		sldIdEl.setAttribute("id", String(sldIdValue))
		sldIdEl.setAttribute("r:id", rid)
		sldIdLst.appendChild(sldIdEl)

		// presentation rels: append relationship.
		const rel = presRels.createElementNS("http://schemas.openxmlformats.org/package/2006/relationships", "Relationship")
		rel.setAttribute("Id", rid)
		rel.setAttribute("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide")
		rel.setAttribute("Target", `slides/slide${nextId - 1}.xml`)
		const relsRoot = presRels.documentElement
		if (!relsRoot) throw new DocumentError("corrupt", "Template presentation.xml.rels has no root element.")
		relsRoot.appendChild(rel)

		// [Content_Types].xml: override for the new slide.
		const override = contentTypes.createElementNS(
			"http://schemas.openxmlformats.org/package/2006/content-types",
			"Override",
		)
		override.setAttribute("PartName", `/${slidePath}`)
		override.setAttribute("ContentType", "application/vnd.openxmlformats-officedocument.presentationml.slide+xml")
		const ctRoot = contentTypes.documentElement
		if (!ctRoot) throw new DocumentError("corrupt", "Template [Content_Types].xml has no root element.")
		ctRoot.appendChild(override)
	}

	pkg.putXml("ppt/presentation.xml", presentation)
	pkg.putXml(presRelsPath, presRels)
	pkg.putXml("[Content_Types].xml", contentTypes)
}

/** Target of a rels part relative to fromDir ("ppt/slides" → "../slideLayouts/x.xml"). */
export function relativeTarget(fromDir: string, target: string): string {
	const from = fromDir.split("/").filter(Boolean)
	const to = target.split("/").filter(Boolean)
	let i = 0
	while (i < from.length && i < to.length && from[i] === to[i]) i++
	const ups = from.length - i
	return `${"../".repeat(ups)}${to.slice(i).join("/")}`
}
