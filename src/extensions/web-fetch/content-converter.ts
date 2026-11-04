// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
/**
 * Content converter — transforms raw HTML into the requested output format.
 *
 * - `markdown`: strips boilerplate, resolves relative URLs, converts via Turndown
 * - `text`: strips boilerplate, extracts textContent via DOM
 * - `html`: returns raw HTML unchanged (passthrough)
 */

// domino: lightweight server-side DOM used by Turndown internally. We depend
// on it explicitly for boilerplate stripping, relative URL resolution, and
// text extraction — none of which Turndown's API can do on its own.
// @ts-expect-error — domino types are declared under 'domino', not '@mixmark-io/domino'
import domino from "@mixmark-io/domino"
import TurndownService from "turndown"

export type OutputFormat = "markdown" | "text" | "html"

/** Elements stripped before conversion (boilerplate / non-content). */
const BOILERPLATE_SELECTORS = "script, style, meta, link, nav, footer, iframe, svg, noscript"

/** Attributes that may contain relative URLs. */
const URL_ATTRIBUTES: ReadonlyArray<{ selector: string; attr: string }> = [
	{ selector: "[href]", attr: "href" },
	{ selector: "[src]", attr: "src" },
	{ selector: "[action]", attr: "action" },
	{ selector: "[poster]", attr: "poster" },
]

/**
 * Convert raw HTML to the requested format.
 *
 * @param html - Raw HTML string
 * @param baseURL - The page's final URL, used to resolve relative URLs
 * @param format - Desired output format
 */
export function convertContent(html: string, baseURL: string, format: OutputFormat): string {
	if (format === "html") {
		return html
	}

	try {
		const doc = domino.createDocument(html)

		// Strip boilerplate elements
		for (const el of doc.querySelectorAll(BOILERPLATE_SELECTORS)) {
			el.remove()
		}

		// Resolve relative URLs to absolute
		resolveRelativeURLs(doc, baseURL)

		if (format === "text") {
			return extractText(doc)
		}

		// format === "markdown"
		return convertToMarkdown(doc)
	} catch {
		return "[Error: failed to parse HTML content]"
	}
}

/**
 * Resolve all relative URLs in the document to absolute using the base URL.
 */
function resolveRelativeURLs(doc: Document, baseURL: string): void {
	for (const { selector, attr } of URL_ATTRIBUTES) {
		for (const el of doc.querySelectorAll(selector)) {
			const value = el.getAttribute(attr)
			if (value) {
				try {
					el.setAttribute(attr, new URL(value, baseURL).href)
				} catch {
					// Malformed URL — leave as-is
				}
			}
		}
	}
}

/** Block-level elements that should produce line breaks in text output. */
const BLOCK_ELEMENTS = new Set([
	"address",
	"article",
	"aside",
	"blockquote",
	"details",
	"dialog",
	"dd",
	"div",
	"dl",
	"dt",
	"fieldset",
	"figcaption",
	"figure",
	"form",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"hgroup",
	"hr",
	"li",
	"main",
	"ol",
	"p",
	"pre",
	"section",
	"table",
	"ul",
	"tr",
	"td",
	"th",
	"br",
])

/**
 * Extract plain text from the document body.
 *
 * Custom DOM walker because neither standard DOM properties nor libraries
 * handle this well:
 * - `textContent` concatenates all text nodes with no whitespace between
 *   block elements ("TitleParagraph" instead of "Title\nParagraph")
 * - `innerText` should be layout-aware per the HTML spec, but domino's
 *   implementation just collapses whitespace like textContent
 * - Turndown is markdown-centric with no plain-text output mode
 *
 * This walks the tree and inserts newlines at block-element boundaries,
 * mirroring what a spec-compliant `innerText` would produce.
 */
function extractText(doc: Document): string {
	const body = doc.body
	if (!body) return ""

	const parts: string[] = []
	walkNode(body, parts)

	return parts
		.join("")
		.split(/\n/)
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter((line) => line.length > 0)
		.join("\n")
}

function walkNode(node: Node, parts: string[]): void {
	if (node.nodeType === 3 /* TEXT_NODE */) {
		parts.push(node.nodeValue ?? "")
		return
	}

	if (node.nodeType !== 1 /* ELEMENT_NODE */) return

	const tag = (node as Element).tagName?.toLowerCase() ?? ""
	const isBlock = BLOCK_ELEMENTS.has(tag)

	if (isBlock) parts.push("\n")

	for (let child = node.firstChild; child; child = child.nextSibling) {
		walkNode(child, parts)
	}

	if (isBlock) parts.push("\n")
}

/**
 * Convert the pre-processed document to markdown via Turndown.
 */
function convertToMarkdown(doc: Document): string {
	const td = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
		hr: "---",
		emDelimiter: "*",
	})

	// Turndown's remove() skips elements during conversion — belt-and-suspenders
	// since we already stripped these from the DOM, but this catches any that
	// Turndown's own parser might re-encounter
	td.remove(["script", "style", "meta", "link"])

	const bodyHTML = doc.body?.innerHTML ?? doc.documentElement?.innerHTML ?? ""
	return td.turndown(bodyHTML)
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
