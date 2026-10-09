/**
 * read_document tool — ranged reads of PDF/DOCX/PPTX/XLSX (plus XLS/ODS/CSV).
 * Transparent plain `read` covers whole small documents; this tool exists
 * for big ones: at most 20 units per call, ≤ 50 KB of text, with a
 * continuation pointer when output truncates.
 *
 * The schema ships in its final Phase-1 shape (locators included; images
 * arrive in Phase 5).
 */

import { readFile, stat } from "node:fs/promises"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { resolveUserPath } from "../../fs-paths.js"
import { extractDocument } from "./extract.js"
import { MAX_OUTPUT_CHARS, MAX_UNITS_PER_CALL } from "./limits.js"
import { DocumentError, type ExtractedDocument, isDocumentError } from "./model.js"
import { parseUnitRange, renderDocument } from "./render.js"

const ReadDocumentSchema = Type.Object({
	path: Type.String({ description: "Path to the document (PDF, DOCX, PPTX, XLSX, XLS, ODS, CSV)." }),
	pages: Type.Optional(
		Type.String({
			description:
				'Unit range to read, 1-based: pages (PDF), slides (PPTX), or sheet numbers (XLSX). E.g. "1-5", "3", "1-5,8". At most 20 units per call.',
		}),
	),
	sheet: Type.Optional(Type.String({ description: 'Sheet name to read (XLSX/XLS/ODS), e.g. "Totals".' })),
	rows: Type.Optional(
		Type.String({ description: 'Spreadsheet row range to read (XLSX/XLS/ODS/CSV), 1-based, e.g. "20-60".' }),
	),
	formulas: Type.Optional(
		Type.Boolean({ description: "Show formula strings instead of computed values (XLSX/XLS/ODS). Default false." }),
	),
	locators: Type.Optional(
		Type.Boolean({
			description:
				'Include edit locators ([table N], [shape "name"]) in the output. Default true; set false to read for content only.',
		}),
	),
	max_chars: Type.Optional(
		Type.Integer({
			minimum: 1000,
			maximum: MAX_OUTPUT_CHARS,
			description: `Maximum output characters (default and maximum ${MAX_OUTPUT_CHARS} — larger reads need narrower ranges).`,
		}),
	),
})

export interface ReadDocumentDeps {
	readFileData?: (path: string) => Promise<Uint8Array>
	env?: NodeJS.ProcessEnv
}

interface ReadDocumentDetails {
	format?: string
	totalUnits?: number
	selectedUnits?: number
	truncated?: boolean
	/** Set on typed failures — mirrors DocumentError.code. */
	errorCode?: string
}

function textResult(text: string, details: ReadDocumentDetails | null = null) {
	return { content: [{ type: "text" as const, text }], details }
}

/**
 * Shared by read_document, the read interception, and @file: load + extract
 * a document path. Wraps fs errors as typed DocumentErrors.
 */
export async function loadExtracted(
	path: string,
	cwd: string,
	deps: ReadDocumentDeps & { tool?: "read" | "read_document" | "at-file" | "doctor" },
): Promise<{ absolute: string; data: Uint8Array; doc: ExtractedDocument }> {
	const absolute = resolveUserPath(path, cwd)
	if (!deps.readFileData) {
		const statInfo = await stat(absolute).catch((err) => {
			throw new DocumentError("corrupt", `Cannot stat ${path}: ${(err as Error).message}`)
		})
		if (!statInfo.isFile()) {
			throw new DocumentError("corrupt", `${path} is not a regular file.`)
		}
	}
	const data = deps.readFileData ? await deps.readFileData(absolute) : new Uint8Array(await readFile(absolute))
	const doc = await extractDocument(absolute, data, {
		env: deps.env,
		tool: deps.tool ?? "read_document",
	})
	return { absolute, data, doc }
}

/** Selection shared by tool + interception: unit indices from pages/sheet. */
export function selectUnits(
	doc: ExtractedDocument,
	params: { pages?: string; sheet?: string },
): {
	indices?: number[]
	error?: string
} {
	if (params.sheet !== undefined) {
		const match = doc.units.filter((u) => u.name === params.sheet || u.label === `Sheet: ${params.sheet}`)
		if (match.length === 0) {
			const names = doc.units.map((u) => u.name ?? u.label).join(", ")
			return { error: `No sheet named "${params.sheet}". Sheets: ${names}` }
		}
		return { indices: match.map((u) => u.index) }
	}
	if (params.pages !== undefined) {
		const indices = parseUnitRange(params.pages, doc.units.length)
		if (indices === undefined) {
			return { error: `Could not parse unit range "${params.pages}" — use forms like "1-5", "3", "1-5,8".` }
		}
		if (indices.length > MAX_UNITS_PER_CALL) {
			return {
				error: `Range "${params.pages}" selects ${indices.length} units; at most ${MAX_UNITS_PER_CALL} per call — narrow the range.`,
			}
		}
		return { indices }
	}
	if (doc.units.length > MAX_UNITS_PER_CALL) {
		return { indices: doc.units.slice(0, MAX_UNITS_PER_CALL).map((u) => u.index) }
	}
	return {}
}

const LOCATOR_PATTERN = /\[(?:table \d+|shape "[^"]*"|chart)\]\n?/g

export function stripLocators(markdown: string): string {
	return markdown.replace(LOCATOR_PATTERN, "").replace(/\n{3,}/g, "\n\n")
}

export function createReadDocumentTool(deps: ReadDocumentDeps = {}): ToolDefinition<typeof ReadDocumentSchema> {
	return {
		name: "read_document",
		label: "Read Document",
		description:
			'Read PDF, DOCX, PPTX, XLSX (also XLS, ODS, CSV) files as Markdown with stable locators ([table N], [shape "name"], cell refs, page numbers). Plain `read` already extracts whole small documents transparently; use this tool for large documents, specific pages/slides/sheets/rows, or spreadsheet formulas. Output is capped (≤20 units, ≤50 KB) — narrow the range and call again when output truncates.',
		parameters: ReadDocumentSchema,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			try {
				const cwd = ctx?.cwd ?? process.cwd()
				const { doc } = await loadExtracted(params.path, cwd, { ...deps, tool: "read_document" })
				// Re-extract with formulas when requested (cheap; keeps cache-free determinism).
				let renderedDoc = doc
				if (params.formulas && (doc.format === "xlsx" || doc.format === "xls" || doc.format === "ods")) {
					const absolute = resolveUserPath(params.path, cwd)
					const data = deps.readFileData ? await deps.readFileData(absolute) : new Uint8Array(await readFile(absolute))
					renderedDoc = await extractDocument(absolute, data, { env: deps.env, tool: "read_document", formulas: true })
				}
				const selection = selectUnits(renderedDoc, params)
				if (selection.error) return textResult(selection.error, { errorCode: "invalid-selection" })
				if (params.locators === false) {
					renderedDoc = {
						...renderedDoc,
						units: renderedDoc.units.map((u) => ({ ...u, markdown: stripLocators(u.markdown) })),
					}
				}
				const out = renderDocument(renderedDoc, {
					unitIndices: selection.indices,
					rows: params.rows,
					maxChars: params.max_chars ?? MAX_OUTPUT_CHARS,
					toolName: "read_document",
					path: params.path,
				})
				const continuation =
					renderedDoc.units.length > (selection.indices?.length ?? renderedDoc.units.length)
						? `\n\nRead more: read_document({ path: ${JSON.stringify(params.path)}, pages: "${
								(selection.indices?.[selection.indices.length - 1] ?? 0) + 1
							}-" })`
						: ""
				return textResult(`${out.text}${continuation}`, {
					format: renderedDoc.format,
					totalUnits: out.totalUnits,
					selectedUnits: out.selectedUnits,
					truncated: out.truncated,
				})
			} catch (err) {
				if (isDocumentError(err)) return textResult(`read_document failed: ${err.message}`, { errorCode: err.code })
				throw err
			}
		},
	}
}
