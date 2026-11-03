/**
 * Structural self-check run before every save (Phase 2+ writers) and by the
 * doctor on read fixtures. Checks ported from the Anthropic OOXML validator:
 *   - content types declared for every part
 *   - <p:presentation> child order is schema-ordered
 *   - chart axis ids referenced by plotArea children are declared
 *
 * These are cheap, deterministic, and format-specific checkers — XSD
 * validation (xmllint-wasm) stays a test-time concern (Phase 2.3).
 */

import type { Element, Document as XmlDocument } from "@xmldom/xmldom"
import { DocumentError } from "../model.js"
import { byTag } from "./xml.js"
// NOTE: `[Content_Types].xml` elements are namespace-qualified; the local
// names (Override/Default) are matched by suffix below.

// --- content types -----------------------------------------------------------

export function validateContentTypes(pkg: { names(): string[] }, contentTypesXml: XmlDocument | undefined): string[] {
	if (!contentTypesXml) return ["missing [Content_Types].xml"]
	const declared = new Set<string>()
	const defaults = new Set<string>()
	const all = contentTypesXml.getElementsByTagName("*")
	for (let i = 0; i < all.length; i++) {
		const el = all.item(i) as Element
		const tag = el.tagName
		if (tag.endsWith("Override")) {
			const part = el.getAttribute("PartName")
			if (part) declared.add(part.startsWith("/") ? part.slice(1) : part)
		} else if (tag.endsWith("Default")) {
			const ext = el.getAttribute("Extension")
			if (ext) defaults.add(ext.toLowerCase())
		}
	}
	const problems: string[] = []
	for (const name of pkg.names()) {
		if (name === "[Content_Types].xml") continue
		if (declared.has(name)) continue
		const ext = name.split(".").pop()?.toLowerCase() ?? ""
		if (!defaults.has(ext)) {
			problems.push(`part ${name} has no content-type entry (no Override, no Default for .${ext})`)
		}
	}
	return problems
}

// --- pptx presentation child order ------------------------------------------

const PRESENTATION_CHILD_ORDER = [
	"sldMasterIdLst",
	"notesMasterIdLst",
	"handoutMasterIdLst",
	"sldIdLst",
	"sldSz",
	"notesSz",
	"embeddedFontLst",
	"custShowLst",
	"photoAlbum",
	"custDataLst",
	"kinsoku",
	"defaultTextStyle",
	"modificationVerifier",
	"extLst",
]

export function validatePresentationChildOrder(presentationXml: XmlDocument): string[] {
	const problems: string[] = []
	const root = presentationXml.documentElement
	if (!root || !/presentation$/.test(root.tagName)) return problems
	let lastRank = -1
	for (const node of Array.from(root.childNodes)) {
		if (node.nodeType !== 1 /* ELEMENT_NODE */) continue
		const local = (node as Element).tagName.split(":").pop() ?? ""
		const rank = PRESENTATION_CHILD_ORDER.indexOf(local)
		if (rank < 0) {
			problems.push(`p:presentation child ${local} is not a known presentation child`)
			continue
		}
		if (rank < lastRank) {
			problems.push(
				`p:presentation child ${local} appears out of schema order (after ${PRESENTATION_CHILD_ORDER[lastRank]})`,
			)
		}
		lastRank = Math.max(lastRank, rank)
	}
	return problems
}

// --- chart axis ids ----------------------------------------------------------

export function validateChartAxisIds(chartXml: XmlDocument): string[] {
	const problems: string[] = []
	const declared = new Set<string>()
	for (const el of byTag(chartXml, "axId")) {
		const parentTag = (el.parentNode as Element | null)?.tagName ?? ""
		const val = el.getAttribute("val")
		if (/(catAx|valAx|dateAx|serAx)$/.test(parentTag)) {
			if (val) declared.add(val)
		}
	}
	for (const el of byTag(chartXml, "axId")) {
		const parentTag = (el.parentNode as Element | null)?.tagName ?? ""
		if (/(catAx|valAx|dateAx|serAx)$/.test(parentTag)) continue // declaration
		const val = el.getAttribute("val")
		if (val && !declared.has(val)) {
			problems.push(`chart references undeclared axis id ${val}`)
		}
	}
	return problems
}

export function requireNoProblems(problems: string[], context: string): void {
	if (problems.length > 0) {
		throw new DocumentError("corrupt", `${context}: ${problems.join("; ")}`)
	}
}
