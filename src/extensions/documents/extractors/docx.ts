/**
 * DOCX extractor: mammoth → HTML, turndown → Markdown, with a table rule
 * that preserves grid structure and emits `[table N]` locators (used by the
 * Phase 4 editor — the read shape ships now so it never has to change).
 *
 * The document is a single unit; per-page slicing doesn't exist for DOCX.
 * Tables render header-agnostic: first row becomes the header row.
 */

import mammoth from "mammoth"
import TurndownService from "turndown"
import { renderMarkdownTable } from "../markdown-table.js"
import { DocumentError, type ExtractedDocument } from "../model.js"

function createTurndown(): { service: TurndownService; tableCount: () => number } {
	const service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" })
	let tables = 0
	service.addRule("documentTables", {
		filter: "table",
		replacement: (_content, node) => {
			tables += 1
			const el = node as unknown as {
				querySelectorAll(selector: string): ArrayLike<{
					querySelectorAll(selector: string): ArrayLike<{ textContent?: string | null }>
				}>
			}
			const rows: string[][] = []
			const trs = el.querySelectorAll("tr")
			for (let r = 0; r < trs.length; r++) {
				const cells: string[] = []
				const tds = trs[r].querySelectorAll("th,td")
				for (let c = 0; c < tds.length; c++) {
					cells.push((tds[c].textContent ?? "").trim())
				}
				rows.push(cells)
			}
			if (rows.length === 0) return ""
			const header = rows[0]
			const body = rows.slice(1)
			const table = renderMarkdownTable(header, body)
			return `\n\n[table ${tables}]\n${table}\n\n`
		},
	})
	return { service, tableCount: () => tables }
}

export async function extractDocx(data: Uint8Array): Promise<ExtractedDocument> {
	let result: Awaited<ReturnType<typeof mammoth.convertToHtml>>
	try {
		result = await mammoth.convertToHtml({ buffer: Buffer.from(data) })
	} catch (err) {
		throw new DocumentError("corrupt", `Not a readable DOCX: ${(err as Error).message}`, "docx")
	}
	const { service } = createTurndown()
	const markdown = service
		.turndown(result.value)
		.replace(/\n{3,}/g, "\n\n")
		.trim()
	const messages = (result.messages ?? []).map((m) => m.message).filter((m): m is string => typeof m === "string")
	const notes = messages.map((m) => `mammoth: ${m}`)
	// Outline from atx headings produced by turndown.
	const outline: string[] = []
	for (const line of markdown.split("\n")) {
		const m = /^(#{1,6})\s+(.*)$/.exec(line)
		if (m) outline.push(`${m[1]} ${m[2].trim()}`.slice(0, 100))
	}
	return {
		format: "docx",
		unitKind: "document",
		units: [{ index: 1, label: "Document", markdown }],
		outline: outline.length > 0 ? outline : ["(no headings)"],
		notes,
	}
}
