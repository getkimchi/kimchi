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

/**
 * Pre-validation guard for tool arguments containing a `gates` array.
 *
 * Registered as `prepareArguments` on every gate-bearing tool so it runs
 * **before** the pi-ai TypeBox schema validation in the agent loop. When
 * the LLM omits a required field from a gate object, TypeBox produces a
 * cryptic error like:
 *
 *   gates.1.evidence: must have required properties evidence
 *
 * That message wastes a retry because it doesn't tell the LLM *what* to
 * provide. This guard detects the same omission and throws an actionable
 * error that names the gate, the missing field, and what the LLM must do.
 *
 * The guard enforces all four mandatory fields (`id`, `verdict`, `rationale`,
 * `evidence`) and rejects entries that are not well-formed objects (null,
 * primitives, arrays). It intentionally does NOT fill in defaults — all four
 * fields are mandatory, and the LLM must supply them.
 */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== ""
}

// biome-ignore lint/suspicious/noExplicitAny: prepareArguments runs on raw LLM JSON; return must satisfy Static<TParams> for any gate schema.
export function assertGateFieldsPresent(args: unknown): any {
	if (args == null || typeof args !== "object") return args
	const obj = args as Record<string, unknown>
	const gates = obj.gates
	if (!Array.isArray(gates)) return obj
	const missing: string[] = []
	for (let i = 0; i < gates.length; i++) {
		const gate = gates[i]
		if (gate == null || typeof gate !== "object" || Array.isArray(gate)) {
			missing.push(`gates[${i}]: invalid gate object (expected {id, verdict, rationale, evidence})`)
			continue
		}
		const g = gate as Record<string, unknown>
		const id = isNonEmptyString(g.id) ? g.id : `gates[${i}]`
		if (!isNonEmptyString(g.id)) missing.push(`gates[${i}]: missing "id"`)
		if (!isNonEmptyString(g.verdict)) missing.push(`${id}: missing "verdict"`)
		if (!isNonEmptyString(g.rationale)) missing.push(`${id}: missing "rationale"`)
		if (!isNonEmptyString(g.evidence)) missing.push(`${id}: missing "evidence"`)
	}
	if (missing.length > 0) {
		throw new Error(
			`Every gate object requires {id, verdict, rationale, evidence}. Fix these and retry:\n${missing.join("\n")}`,
		)
	}
	return obj
}

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
