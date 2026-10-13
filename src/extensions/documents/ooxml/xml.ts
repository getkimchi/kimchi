/**
 * xmldom helpers + the OOXML namespace map. One parsing façade so every
 * consumer (PPTX reader now, OOXML editors later) gets the same DOM that
 * serializes back faithfully — untouched parts are carried through unchanged.
 */

import { DOMParser, type Element, XMLSerializer, type Document as XmlDocument } from "@xmldom/xmldom"

export const NS = {
	w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
	a: "http://schemas.openxmlformats.org/drawingml/2006/main",
	p: "http://schemas.openxmlformats.org/presentationml/2006/main",
	r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
	c: "http://schemas.openxmlformats.org/drawingml/2006/chart",
	s: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
	rel: "http://schemas.openxmlformats.org/package/2006/relationships",
	ct: "http://schemas.openxmlformats.org/package/2006/content-types",
} as const

export function parseXml(source: string): XmlDocument {
	const errors: string[] = []
	let doc: XmlDocument
	try {
		doc = new DOMParser({
			onError: (level, message) => {
				if (level !== "warning") errors.push(String(message))
			},
		}).parseFromString(source, "text/xml")
	} catch (err) {
		throw new Error(`XML parse failed: ${(err as Error).message}`)
	}
	if (errors.length > 0) throw new Error(`XML parse failed: ${errors.join("; ")}`)
	return doc
}

export function serializeXml(doc: XmlDocument): string {
	return new XMLSerializer().serializeToString(doc)
}

/**
 * Namespace-agnostic element search by LOCAL name: `byTag(doc, "axId")`
 * matches `<c:axId>`. getElementsByTagName on prefixed docs is
 * qualified-name sensitive, so we scan `*` and compare suffixes.
 */
export function byTag(element: XmlDocument | Element, localName: string): Element[] {
	const nodes = element.getElementsByTagName("*")
	const out: Element[] = []
	for (let i = 0; i < nodes.length; i++) {
		const el = nodes.item(i) as Element
		const tag = el.tagName
		if (tag === localName || tag.endsWith(`:${localName}`)) out.push(el)
	}
	return out
}

/** Concatenated text of all descendant <w:t>/<a:t>-style text nodes under `el`. */
export function textContentOf(el: Element, localNames: readonly string[]): string {
	let text = ""
	for (const name of localNames) {
		const nodes = el.getElementsByTagName(name)
		for (let i = 0; i < nodes.length; i++) {
			text += nodes.item(i)?.textContent ?? ""
		}
	}
	return text
}

/**
 * text with xml:space="preserve" on the nearest ancestor getAttr? Callers
 * setting text with leading/trailing whitespace must set xml:space="preserve"
 * on the <a:t>/<w:t> element (enforced as a pitfall in writers).
 */
export function setTextPreservingSpace(el: Element, text: string): void {
	el.textContent = text
	if (/^\s|\s$/.test(text)) el.setAttribute("xml:space", "preserve")
}
