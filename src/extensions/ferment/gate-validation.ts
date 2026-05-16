/**
 * Gate-validation middleware — the contract every completion tool runs at the
 * top of its handler.
 *
 * Three checks, in order:
 *   1. Coverage: every gate the turn owns must be present, no duplicates,
 *      no extras. Enforced by `assertGateCoverage`.
 *   2. Shape: each verdict has a valid {id, verdict, rationale, evidence}.
 *      Enforced by `validateGateVerdict`.
 *   3. Blocking flag short-circuit (opt-in): if `flagPolicy: "block-on-flag"`,
 *      a "flag" verdict returns a tool error with the rendered flag lines.
 *      `complete_ferment_phase` opts OUT of this — phase-level flags feed the
 *      retry/escalation pipeline downstream, not an immediate refusal.
 *
 * Returns null when validation passes (caller proceeds). Returns a tool
 * result when validation fails (caller returns it directly).
 *
 * One call site per completion tool. Strict from day one.
 */

import {
	GateCoverageError,
	type OwnerTurn,
	assertGateCoverage,
	flaggedVerdicts,
	hasBlockingFlag,
	validateGateVerdict,
} from "./gate-registry.js"
import { toolErr, type toolOk } from "./tool-helpers.js"

type ToolResult = ReturnType<typeof toolOk> | ReturnType<typeof toolErr>

export type GateFlagPolicy =
	/** Any "flag" verdict refuses the call with a tool error. Used by
	 *  scope_ferment, propose_ferment_scoping, complete_ferment_step, complete_ferment. */
	| "block-on-flag"
	/** Coverage + shape only. "flag" verdicts are caller's problem — they
	 *  feed into a retry/escalation pipeline downstream. Used by complete_ferment_phase. */
	| "coverage-only"

export interface GateValidationOptions {
	turn: OwnerTurn
	flagPolicy: GateFlagPolicy
	/** Rendered into the flag-refusal error message when flagPolicy is
	 *  "block-on-flag". Caller-specific so the agent gets useful context.
	 *
	 *  Receives the count of flagged verdicts so the message can pluralize. */
	renderFlagError?: (flagCount: number, flagLines: string) => string
}

function normalizeGateVerdict(v: { id: string; verdict: string }, turn: OwnerTurn): void {
	// The schema accepts S2 verification-classification aliases defensively
	// because models often put "smoke" in `verdict`. Only S2 on complete_ferment_step
	// may use those aliases; all other gates must stay canonical.
	if (turn !== "complete_ferment_step" || v.id !== "S2") return
	switch (v.verdict) {
		case "smoke":
		case "test":
		case "syntactic":
			v.verdict = "pass"
			return
		case "proxy":
		case "sentinel":
			v.verdict = "flag"
			return
		default:
			return
	}
}

/** Run gate validation. Returns null on pass; returns a tool-error result
 *  on coverage failure, shape failure, or (if policy is block-on-flag)
 *  any "flag" verdict. Caller short-circuits by returning the result. */
export function validateGatesOrErr(
	gates: ReadonlyArray<{ id: string; verdict: string; rationale: string; evidence: string }> | undefined,
	options: GateValidationOptions,
): ToolResult | null {
	// 1. Coverage check.
	try {
		assertGateCoverage(gates, options.turn)
	} catch (err) {
		if (err instanceof GateCoverageError) return toolErr(err.message)
		throw err
	}

	// 2. Per-verdict shape check. By here, gates is guaranteed to be an array.
	const verdicts = gates as Array<{ id: string; verdict: string; rationale: string; evidence: string }>
	for (const v of verdicts) {
		normalizeGateVerdict(v, options.turn)
	}
	for (const v of verdicts) {
		const shapeError = validateGateVerdict(v)
		if (shapeError) return toolErr(shapeError)
	}

	// 3. Optional flag-block.
	if (options.flagPolicy === "block-on-flag" && hasBlockingFlag(verdicts)) {
		const flagged = flaggedVerdicts(verdicts)
		const flagLines = flagged.map((v) => `  ⛔ Gate ${v.id}: ${v.rationale}\n     evidence: ${v.evidence}`).join("\n")
		const message = options.renderFlagError?.(flagged.length, flagLines)
		if (!message) {
			// Sensible default; callers should provide a custom render for better UX.
			return toolErr(`Call refused — agent self-flagged on ${flagged.length} gate(s):\n\n${flagLines}`)
		}
		return toolErr(message)
	}

	return null
}
