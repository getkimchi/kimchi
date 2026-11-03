/**
 * DOCX writing pitfalls as code — each rule is enforced before the writer
 * produces output, and each has a fixture in docx-pitfalls.test.ts. Modeled
 * on pitfalls.ts for PPTX.
 *
 * Sources: the docx library's own docs/issues (table width contract, run
 * text constraints) and the workstream plan's pitfall list.
 */

import type { Block } from "../markdown/blocks.js"

export interface DocxPitfallInput {
	blocks: Block[]
	/** Resolved page content width in DXA (page width minus margins). */
	contentWidthDxa: number
}

function* walkBlocks(blocks: Block[]): Generator<Block> {
	for (const b of blocks) {
		yield b
		if (b.type === "list") for (const item of b.items) yield* walkBlocks(item)
		if (b.type === "blockquote") yield* walkBlocks(b.blocks)
	}
}

/** Tables: every row must have the same column count (the writer spreads
 *  columnWidths evenly; ragged tables render with missing cells in Word). */
function assertRegularTables(input: DocxPitfallInput): void {
	for (const b of walkBlocks(input.blocks)) {
		if (b.type !== "table") continue
		const cols = b.header.length
		if (cols === 0) throw new Error("table-needs-header: a DOCX table needs at least one column")
		const width = Math.floor(input.contentWidthDxa / cols)
		if (width * cols > input.contentWidthDxa) {
			throw new Error(`table-widths-too-wide: ${cols} columns of ${width} DXA exceed content width`)
		}
		for (const row of b.rows) {
			if (row.length !== cols) {
				throw new Error(
					`table-rows-must-match-header: row has ${row.length} cells, header has ${cols} — ragged tables are rejected`,
				)
			}
		}
	}
}

/** Charts are out of scope for the DOCX writer in v1; fail loudly instead
 *  of silently dropping a chart block. */
function assertNoCharts(input: DocxPitfallInput): void {
	for (const b of walkBlocks(input.blocks)) {
		if (b.type === "chart") {
			throw new Error("chart-not-supported-in-docx: DOCX charts are not supported yet — use a table or an image")
		}
	}
}

/** Images: the ImageRun type is required by the docx library; unknown
 *  extensions are rejected here instead of at pack time. */
const IMAGE_TYPES = new Set(["png", "jpg", "jpeg", "gif", "bmp"])
export function assertImageTypes(input: DocxPitfallInput): void {
	for (const b of walkBlocks(input.blocks)) {
		if (b.type !== "image") continue
		const ext = b.href.split("?")[0].split(".").pop()?.toLowerCase() ?? ""
		if (!IMAGE_TYPES.has(ext)) {
			throw new Error(
				`image-type-must-be-known: ${b.href} — supported: ${[...IMAGE_TYPES].join(", ")} (the library requires an explicit type)`,
			)
		}
	}
}

/** Run every guard. Throws `Error` with `${rule-id}: …` on violation. */
export function enforceDocxPitfalls(input: DocxPitfallInput): void {
	assertRegularTables(input)
	assertNoCharts(input)
	assertImageTypes(input)
}
