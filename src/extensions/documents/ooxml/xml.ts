/**
 * xmldom helpers + the OOXML namespace map. One parsing façade so every
 * consumer (PPTX reader now, OOXML editors later) gets the same DOM that
 * serializes back faithfully — untouched parts are carried through unchanged.
 */

import { DOMParser, type Element, XMLSerializer, type Document as XmlDocument } from "@xmldom/xmldom"
import { DocumentError } from "../model.js"

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
		throw new DocumentError("corrupt", `XML parse failed: ${(err as Error).message}`)
	}
	if (errors.length > 0) throw new DocumentError("corrupt", `XML parse failed: ${errors.join("; ")}`)
	return doc
}

export function serializeXml(doc: XmlDocument): string {
	return new XMLSerializer().serializeToString(doc)
}

/**
 * Namespace declarations of `xml`'s root start tag, as canonical
 * `xmlns:p="uri"` / `xmlns="uri"` strings. String-scan only — no DOM — so
 * callers parsing fragments of a huge part can reuse them cheaply. Attributes
 * may use single or double quotes; the returned strings always use double.
 */
export function rootNamespaceDecls(xml: string): string[] {
	// Skip the prolog: whitespace, XML declarations and comments.
	let i = 0
	for (;;) {
		while (i < xml.length && xml.charCodeAt(i) <= 32) i++
		if (xml.startsWith("<?", i)) {
			const end = xml.indexOf("?>", i + 2)
			if (end < 0) return []
			i = end + 2
			continue
		}
		if (xml.startsWith("<!--", i)) {
			const end = xml.indexOf("-->", i + 4)
			if (end < 0) return []
			i = end + 3
			continue
		}
		break
	}
	if (xml[i] !== "<" || xml[i + 1] === "!" || xml[i + 1] === "?") return []
	// Scan the start tag quote-aware so a `>` inside an attribute can't end it.
	let inQuote: string | undefined
	let j = i
	for (; j < xml.length; j++) {
		const ch = xml[j]
		if (inQuote) {
			if (ch === inQuote) inQuote = undefined
		} else if (ch === '"' || ch === "'") {
			inQuote = ch
		} else if (ch === ">") {
			break
		}
	}
	const startTag = xml.slice(i, j)
	const out: string[] = []
	const re = /[\s>/]xmlns(?::([\w.-]+))?\s*=\s*("([^"]*)"|'([^']*)')/g
	for (let m = re.exec(startTag); m !== null; m = re.exec(startTag)) {
		out.push(`xmlns${m[1] ? `:${m[1]}` : ""}="${m[3] ?? m[4] ?? ""}"`)
	}
	return out
}

/**
 * Namespace declarations usable for parsing FRAGMENTS of `partXml`: the
 * declarations on the part's root, plus any `required` prefix the root
 * doesn't declare (a defensive fallback for parts that declare `w:`/`r:`
 * only inside rare attributes). Returns a single space-joined string.
 */
export function fragmentNamespaces(partXml: string, required: { prefix: string; uri: string }[]): string {
	const decls = rootNamespaceDecls(partXml)
	const declared = new Set(decls.map((d) => d.slice(5, d.indexOf("=")))) // "" for default, ":w" for prefixed
	for (const req of required) {
		const key = req.prefix === "" ? "" : `:${req.prefix}`
		if (!declared.has(key)) decls.push(`xmlns${key}="${req.uri}"`)
	}
	return decls.join(" ")
}

/**
 * Parse a fragment of a part by wrapping it in `<wrapperQName nsDecls…>`.
 * The fragment relies on its part's root xmlns declarations, so callers are
 * expected to pass `fragmentNamespaces(partXml, …)` — xmldom rejects any
 * prefix it cannot resolve (NamespaceError at parse time).
 */
export function parseFragment(fragment: string, wrapperQName: string, nsDecls: string): XmlDocument {
	const attrs = nsDecls ? ` ${nsDecls}` : ""
	return parseXml(`<${wrapperQName}${attrs}>${fragment}</${wrapperQName}>`)
}

/**
 * Serialize the wrapper's children back to fragment shape. xmldom hoists the
 * wrapper's xmlns declarations onto its children; strip exactly the
 * declarations in `nsDecls` so the result keeps the fragment's original
 * byte shape. A decl redeclared inside the fragment with the SAME prefix
 * and URI is semantically identical, so stripping it is neutral; a
 * redeclaration with a different URI is preserved (strip matches the full
 * `prefix="uri"` pair).
 */
export function serializeFragmentChildren(doc: XmlDocument, nsDecls: string): string {
	const ser = new XMLSerializer()
	const root = doc.documentElement
	if (!root) return ""
	let out = ""
	for (let i = 0; i < root.childNodes.length; i++) {
		const node = root.childNodes.item(i)
		if (node) out += ser.serializeToString(node)
	}
	for (const decl of nsDecls.split(" ")) {
		if (decl) out = out.replaceAll(` ${decl}`, "")
	}
	return out
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
/** Direct child ELEMENTS of `el` (matching byTag's traversal style, one level). */
export function childElements(el: Element): Element[] {
	const out: Element[] = []
	for (let i = 0; i < el.childNodes.length; i++) {
		const child = el.childNodes.item(i)
		if (child?.nodeType === 1) out.push(child as Element)
	}
	return out
}

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
