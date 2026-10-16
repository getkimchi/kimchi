/**
 * Exit-eval skeleton: deterministic end-of-flow invariants a finished
 * document task must satisfy, expressed without any LLM judge (that judge is
 * a Phase 3 concern — here the invariant set itself is the deliverable).
 *
 * Invariants (PPTX Phase 0):
 *   readability       — round-tripping a deck through read twice is stable.
 *   locator_stability — [shape "..."]/Notes blocks appear in the same order.
 *   op_reachability   — every supported op applies on the reference fixture.
 */
import { applyPptxOps, type PptxOp } from "../editors/pptx.js"
import { extractPptx } from "../extractors/pptx.js"
import { makeTemplatedPptx } from "../fixtures/builders.js"
import type { OoxmlPackage } from "../ooxml/package.js"
import { openOoxml } from "../ooxml/package.js"

export interface ExitInvariantResult {
	name: string
	pass: boolean
	detail?: string
}

export interface ExitEvalReport {
	target: "pptx"
	ok: boolean
	invariants: ExitInvariantResult[]
}

const REACHABLE_OPS: PptxOp[] = [
	{ type: "set_shape_text", slide: 1, shape: "Title 1", value: "eval" },
	{ type: "set_shape_notes", slide: 2, value: "eval-note" },
	{ type: "set_table_cell", slide: 3, table: 1, cell: "B2", value: "eval-cell" },
	{ type: "set_table_row", slide: 3, table: 1, row: 1, values: ["a", "b"] },
	{ type: "append_slide", title: "eval-append" },
	{ type: "delete_slide", index: 2 },
	{ type: "reorder_slides", order: [2, 1, 3] },
]

export async function exitEval(deck: Uint8Array): Promise<ExitEvalReport> {
	const invariants: ExitInvariantResult[] = []

	// readability: double extraction must be identical.
	const first = await extractPptx(deck)
	const second = await extractPptx(deck)
	invariants.push({
		name: "readability",
		pass: JSON.stringify(first.units) === JSON.stringify(second.units),
	})

	// op_reachability: each op applies in isolation on its own package.
	for (const op of REACHABLE_OPS) {
		// append_slide needs deck layouts; the generic fixture package may lack them.
		const source = op.type === "append_slide" ? await makeTemplatedPptx() : deck
		const pkg: OoxmlPackage = await openOoxml(source)
		try {
			applyPptxOps(pkg, [op])
			invariants.push({ name: `op:${op.type}`, pass: true })
		} catch (err) {
			invariants.push({ name: `op:${op.type}`, pass: false, detail: (err as Error).message })
		}
	}

	// locator_stability after edits: shapes still carry their [shape "..."] names.
	const edited = await openOoxml(deck)
	try {
		applyPptxOps(edited, [{ type: "set_shape_text", slide: 1, shape: "Title 1", value: "post" }])
		const doc = await extractPptx(await edited.save())
		invariants.push({
			name: "locator_stability",
			pass: doc.units[0]?.markdown.includes('[shape "Title 1"]') === true,
		})
	} catch (err) {
		invariants.push({ name: "locator_stability", pass: false, detail: (err as Error).message })
	}

	return { target: "pptx", ok: invariants.every((i) => i.pass), invariants }
}

/** Machine-readable score contract (binary per invariant, json on disk later). */
export function scoreExitEval(report: ExitEvalReport): {
	target: string
	exit_status: "pass" | "fail"
	invariants: Array<{ name: string; result: "pass" | "fail"; detail?: string }>
} {
	return {
		target: report.target,
		exit_status: report.ok ? "pass" : "fail",
		invariants: report.invariants.map((i) => ({
			name: i.name,
			result: i.pass ? ("pass" as const) : ("fail" as const),
			detail: i.detail,
		})),
	}
}
