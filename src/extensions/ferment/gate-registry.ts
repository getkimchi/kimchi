/**
 * Ferment gate registry — single source of truth for structured quality gates.
 *
 * Modeled on GSD-2's gate registry. Each gate is a named question the working
 * agent must answer when calling a complete_* tool. The agent produces:
 *
 *   { id, verdict: "pass" | "flag" | "omitted", rationale, evidence }
 *
 * Gates are owned by exactly one tool turn (scope, complete_ferment_step,
 * complete_ferment_phase, complete_ferment). A "flag" verdict refuses advancement and
 * feeds the same retry/escalation pipeline as project-check failures. An
 * "omitted" verdict requires a rationale explaining why the gate doesn't apply.
 *
 * Design notes:
 *   - GATE_REGISTRY is exhaustiveness-checked against GateId — adding an id
 *     without a registry entry is a compile error.
 *   - getGatesForTurn(turn) returns the gates a tool owns, in declaration order.
 *   - assertGateCoverage(verdicts, turn) throws if the agent passed gates the
 *     turn does not own, or omitted gates the turn requires.
 *
 * The registry replaces the free-form judgeReviewPhase / judgeGradeStep /
 * judgePlan / judgeFermentComplete calls. The single remaining LLM-as-judge
 * call is judgeStepVerification (interprets non-zero verify exits, tactical).
 */

export type GateId =
	// Plan-scope (owned by scope_ferment / propose_ferment_scoping)
	| "P1"
	| "P2"
	| "P3"
	// Step-scope (owned by complete_ferment_step)
	| "S1"
	| "S2"
	| "S3"
	// Phase-scope (owned by complete_ferment_phase)
	| "F1"
	| "F2"
	| "F3"
	// Ferment-scope (owned by complete_ferment)
	| "C1"
	| "C2"
	| "C3"

export type GateScope = "plan" | "step" | "phase" | "ferment"

export type OwnerTurn = "scope_ferment" | "complete_ferment_step" | "complete_ferment_phase" | "complete_ferment"

export type GateVerdictValue = "pass" | "flag" | "omitted"

export interface GateDefinition {
	id: GateId
	scope: GateScope
	ownerTurn: OwnerTurn
	/** One-sentence question the agent must answer. */
	question: string
	/** Markdown-ish guidance describing what a good answer looks like.
	 *  This text is rendered into the tool description so the agent sees
	 *  exactly what's expected. */
	guidance: string
}

export interface GateVerdict {
	id: GateId
	verdict: GateVerdictValue
	/** One-sentence justification. Required for every verdict. */
	rationale: string
	/** File:line, quoted diff line, command output, or "n/a" for omitted. */
	evidence: string
}

export const GATE_REGISTRY = {
	// ─── Plan-scope ───────────────────────────────────────────────────────────
	P1: {
		id: "P1",
		scope: "plan",
		ownerTurn: "scope_ferment",
		question: "Does each phase have a verifiable success signal?",
		guidance: [
			"For every proposed phase, point to the concrete check that proves it succeeded.",
			"A check is a bash command exit, a passing test, a function that returns a value matching a spec — something a script can decide.",
			'Reject "looks good", "compiles", or "no errors logged" as success signals — those are not verifications.',
			"Return 'flag' if any phase has no verifiable signal; 'pass' only when every phase does.",
		].join("\n"),
	},
	P2: {
		id: "P2",
		scope: "plan",
		ownerTurn: "scope_ferment",
		question: "Are phases ordered so each one's output is the next one's input?",
		guidance: [
			"Walk the phase list and confirm phase N produces something phase N+1 consumes.",
			"Independent buckets of work that don't compose are a structural smell — flag them.",
			"Parallel-group phases are exempt from sequencing but must converge into a shared next phase's input.",
			"Return 'omitted' for single-phase ferments.",
		].join("\n"),
	},
	P3: {
		id: "P3",
		scope: "plan",
		ownerTurn: "scope_ferment",
		question: "What evidence must complete_ferment see to ship?",
		guidance: [
			"Declare the explicit checklist complete_ferment will validate against — files exist, tests pass, behavior demonstrated.",
			"This list is the contract C1 will walk at ship time. Vague entries here become uncatchable failures later.",
			"Cite the success criteria from the scope. If success criteria is empty, write one now.",
		].join("\n"),
	},

	// ─── Step-scope ───────────────────────────────────────────────────────────
	S1: {
		id: "S1",
		scope: "step",
		ownerTurn: "complete_ferment_step",
		question: "Does the summary describe work present in the diff?",
		guidance: [
			"Read your own summary. For each concrete claim (file path, function name, behavior), cite the diff line that proves it.",
			"If you claim a file you didn't touch, or a function not in the diff — flag this gate.",
			"Empty diff with a non-trivial summary is always a flag.",
			"'omitted' is only valid for steps with no code change (e.g. research, planning).",
		].join("\n"),
	},
	S2: {
		id: "S2",
		scope: "step",
		ownerTurn: "complete_ferment_step",
		question: "What did the verify command actually exercise?",
		guidance: [
			"Classify your own verify command honestly:",
			"  - smoke:   runs the artifact end-to-end (function call, CLI invocation, request/response)",
			"  - test:    executes a real test that asserts behavior",
			"  - syntactic: type-check, compile-check, lint — proves shape, not behavior",
			"  - proxy:   greps output, checks file existence, counts lines — proves nothing about correctness",
			"  - sentinel: touches a file or echoes a string — pure ceremony, no signal",
			"Put that classification in rationale/evidence. The verdict itself should still be pass, flag, or omitted.",
			"Return 'flag' if your verify is proxy or sentinel for a step that claims semantic work.",
			"Return 'omitted' for steps with no verification command (your S1 evidence carries the weight).",
		].join("\n"),
	},
	S3: {
		id: "S3",
		scope: "step",
		ownerTurn: "complete_ferment_step",
		question: "What edge case would break this step?",
		guidance: [
			"Name one concrete input or condition that would make your work fail.",
			"Empty input, malformed input, concurrent access, missing dependency, network failure — pick the most likely.",
			"Then state whether your work handles it. If not, that's a 'flag' — you've identified a known gap.",
			"'omitted' is only valid for steps with no externally-driven behavior (pure config edits, doc-only changes).",
		].join("\n"),
	},

	// ─── Phase-scope ──────────────────────────────────────────────────────────
	F1: {
		id: "F1",
		scope: "phase",
		ownerTurn: "complete_ferment_phase",
		question: "Did every step's claim verify against real behavior, or are some proxies?",
		guidance: [
			"Read the S2 verdicts from every step in this phase.",
			"If every step is 'proxy' or 'sentinel', the phase's verification trail is hollow — flag.",
			"Mixed (some real verifications, some proxies) is acceptable if the real ones cover the load-bearing logic.",
			"Cite which steps were proxy and why that's acceptable (or not).",
		].join("\n"),
	},
	F2: {
		id: "F2",
		scope: "phase",
		ownerTurn: "complete_ferment_phase",
		question: "Does the phase's combined output deliver the phase goal?",
		guidance: [
			"Restate the phase goal in one sentence, then map the union of step outputs to that goal.",
			"A phase where every step is done but the phase goal is still not met is a 'flag'.",
			"Cite the specific artifact (file, behavior, command output) that demonstrates the goal.",
		].join("\n"),
	},
	F3: {
		id: "F3",
		scope: "phase",
		ownerTurn: "complete_ferment_phase",
		question: "What was left undone or deferred in this phase?",
		guidance: [
			"List anything you couldn't do, skipped, or deferred — by step or by intent.",
			"Be explicit. 'Nothing deferred' is a valid verdict only if it's actually true.",
			"Deferred items will be read by C2 at complete_ferment. Hiding them here makes the ship gate fail later.",
			"Return 'pass' when nothing is deferred; 'flag' when items are deferred without explicit acceptance.",
		].join("\n"),
	},

	// ─── Ferment-scope ────────────────────────────────────────────────────────
	C1: {
		id: "C1",
		scope: "ferment",
		ownerTurn: "complete_ferment",
		question: "Is every success criterion from the plan satisfied? Cite evidence.",
		guidance: [
			"Walk the P3 checklist declared at scope time.",
			"For each criterion, name the file, test, or command output that proves it.",
			"Return 'flag' if any criterion is unmet or unverifiable — do not ship.",
			"Return 'omitted' only when no success criteria were declared (P3 was 'omitted').",
		].join("\n"),
	},
	C2: {
		id: "C2",
		scope: "ferment",
		ownerTurn: "complete_ferment",
		question: "Are there phases with unresolved F3 (left-undone) items?",
		guidance: [
			"Read every phase's F3 verdict.",
			"If a phase declared deferred items, either: (a) cite the later phase that resolved them, or (b) explicitly accept them as out-of-scope follow-ups.",
			"Unresolved deferrals without explicit acceptance are 'flag' — the work is incomplete.",
		].join("\n"),
	},
	C3: {
		id: "C3",
		scope: "ferment",
		ownerTurn: "complete_ferment",
		question: "Did real verification ever execute the artifact, or is the work proxy-verified?",
		guidance: [
			"Read every S2 and F1 verdict across the ferment.",
			"If the entire chain is proxy/sentinel/syntactic, the work has never actually run — 'flag', refuse ship.",
			"Cite at least one step where verify was 'smoke' or 'test' and exercised the load-bearing artifact.",
		].join("\n"),
	},
} as const satisfies Record<GateId, GateDefinition>

export type GateRegistry = typeof GATE_REGISTRY

const ORDERED_GATES: readonly GateDefinition[] = Object.values(GATE_REGISTRY) as readonly GateDefinition[]

/** Return the gates a turn owns, in declaration order. */
export function getGatesForTurn(turn: OwnerTurn): GateDefinition[] {
	return ORDERED_GATES.filter((g) => g.ownerTurn === turn)
}

/** Return the set of gate ids a turn owns. */
export function getGateIdsForTurn(turn: OwnerTurn): Set<GateId> {
	return new Set(getGatesForTurn(turn).map((g) => g.id))
}

/** Look up a definition by gate id, or undefined if unknown. */
export function getGateDefinition(id: string): GateDefinition | undefined {
	return (GATE_REGISTRY as Record<string, GateDefinition>)[id]
}

/** Render the question + guidance for a turn as a markdown block.
 *  Designed to be embedded into a tool description so the agent sees the
 *  exact contract when deciding what to put in the `gates` parameter. */
export function renderGateGuidance(turn: OwnerTurn): string {
	const gates = getGatesForTurn(turn)
	if (gates.length === 0) return ""
	const lines: string[] = []
	for (const g of gates) {
		lines.push(`**${g.id}** — ${g.question}`)
		lines.push(g.guidance)
		lines.push("")
	}
	return lines.join("\n").trimEnd()
}

export class GateCoverageError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "GateCoverageError"
	}
}

/** Strict coverage check: every gate the turn owns must appear in `verdicts`,
 *  with no extras. Throws GateCoverageError on mismatch. The thrown error is
 *  caught at the tool boundary and surfaced to the agent as a tool error so
 *  the call retries with a complete verdict set.
 *
 *  Accepts `string` ids on the input side because the TypeBox-derived param
 *  types widen GateId to string — this is the boundary where we re-narrow.
 *  Also tolerates `undefined` / non-array input: typebox schema validation
 *  normally rejects missing `gates` before we get here, but in dev/test
 *  paths that bypass schema validation we want a clean error message, not
 *  a TypeError. */
export function assertGateCoverage(verdicts: ReadonlyArray<{ id: string }> | undefined, turn: OwnerTurn): void {
	if (!Array.isArray(verdicts)) {
		const expected = [...getGateIdsForTurn(turn)].sort()
		throw new GateCoverageError(
			`turn "${turn}" requires a 'gates' array with verdicts for: ${expected.join(", ")}. Each gate requires {id, verdict, rationale, evidence}.`,
		)
	}
	const expected = getGateIdsForTurn(turn)
	const provided = new Set<string>()

	const unknown: string[] = []
	for (const v of verdicts) {
		if (provided.has(v.id)) {
			throw new GateCoverageError(`duplicate gate verdict: ${v.id}`)
		}
		provided.add(v.id)
		const def = getGateDefinition(v.id)
		if (!def) {
			unknown.push(v.id)
			continue
		}
		if (def.ownerTurn !== turn) {
			unknown.push(`${v.id} (owned by ${def.ownerTurn}, not ${turn})`)
		}
	}

	if (unknown.length > 0) {
		throw new GateCoverageError(`turn "${turn}" received gate verdicts it does not own: ${unknown.join(", ")}`)
	}

	const missing: GateId[] = []
	for (const id of expected) {
		if (!provided.has(id)) missing.push(id)
	}
	if (missing.length > 0) {
		throw new GateCoverageError(
			`turn "${turn}" is missing required gate verdicts: ${missing.join(", ")}. Each gate requires {id, verdict, rationale, evidence}.`,
		)
	}
}

/** Validate the shape of an individual verdict. Returns null when ok, error
 *  string otherwise. Use this AFTER assertGateCoverage to catch malformed
 *  individual rows.
 *
 *  Accepts a TypeBox-derived shape (id widened to string) and narrows on
 *  lookup. */
export function validateGateVerdict(v: { id: string; verdict: string; rationale: string; evidence: string }):
	| string
	| null {
	if (!v.id) return "gate verdict missing id"
	const def = getGateDefinition(v.id)
	if (!def) return `gate verdict has unknown id: ${v.id}`
	if (v.verdict !== "pass" && v.verdict !== "flag" && v.verdict !== "omitted") {
		return `gate ${v.id} has invalid verdict: ${v.verdict} (expected pass | flag | omitted)`
	}
	if (typeof v.rationale !== "string" || v.rationale.trim().length === 0) {
		return `gate ${v.id} requires a non-empty rationale`
	}
	if (typeof v.evidence !== "string" || v.evidence.trim().length === 0) {
		return `gate ${v.id} requires non-empty evidence (use "n/a" for omitted)`
	}
	return null
}

/** True when any verdict in the set is a blocking flag. Tolerates undefined
 *  input so callers don't have to guard at every site. */
export function hasBlockingFlag(verdicts: ReadonlyArray<{ verdict: string }> | undefined): boolean {
	return Array.isArray(verdicts) && verdicts.some((v) => v.verdict === "flag")
}

/** Return only the flagged verdicts, in input order. Tolerates undefined. */
export function flaggedVerdicts<V extends { verdict: string }>(verdicts: ReadonlyArray<V> | undefined): V[] {
	return Array.isArray(verdicts) ? verdicts.filter((v) => v.verdict === "flag") : []
}
