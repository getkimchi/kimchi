/**
 * Rollout flags + verbatim decision criteria for the memory gates.
 *
 * Criteria text is load-bearing — the spike was burned twice by
 * paraphrasing: a "coding-assistant sessions" framing made d3 under-value
 * personal-life categories, and omitting the assistant-engaged category
 * killed every assistant-type needle window in LongMemEval. Every builder
 * below carries the EXACT text validated in the spike experiments
 * (.kimchi/docs/decision-model-spike/, E1–E8); the co-located test pins
 * the strings and asserts the taxonomy categories of the extraction
 * prompts stay represented. Change criteria only with a calibration run.
 *
 * Pure — unit-testable under Node.
 */
import type { ChoiceQuestion } from "./decision-gate.js"

/** The gates that exist; each maps to one insertion point in the pipeline. */
export const DECISION_GATE_KINDS = ["valuation", "triage", "digest", "recall", "supersede"] as const
export type DecisionGateKind = (typeof DECISION_GATE_KINDS)[number]

export interface ParsedGateFlags {
	/** Enabled gates. Absent/empty env = all gates on (memory-enabled implies gates on). */
	enabled: ReadonlySet<DecisionGateKind>
	/** Unrecognized names from the env value — log once at the call site, never throw. */
	unknown: string[]
}

/**
 * KIMCHI_MEMORY_DECISION_GATE: `off` disables every gate; a comma subset
 * (`valuation,digest`) enables exactly those; absent/empty enables all.
 * Rollback is total and immediate: gates are pure filters, so `off`
 * restores pre-gate behavior exactly. Unknown names are surfaced, not
 * fatal (a stale value must not break a session).
 */
export function parseDecisionGateFlag(envValue: string | undefined): ParsedGateFlags {
	if (envValue === undefined || envValue.trim() === "") {
		return { enabled: new Set(DECISION_GATE_KINDS), unknown: [] }
	}
	const trimmed = envValue.trim().toLowerCase()
	if (trimmed === "off") return { enabled: new Set(), unknown: [] }
	const enabled = new Set<DecisionGateKind>()
	const unknown: string[] = []
	for (const part of trimmed.split(",")) {
		const name = part.trim()
		if (name === "") continue
		if ((DECISION_GATE_KINDS as readonly string[]).includes(name)) enabled.add(name as DecisionGateKind)
		else unknown.push(name)
	}
	return { enabled, unknown }
}

/** Resolve the enabled set against the process environment (call sites cache nothing; gates stay cheap to re-read). */
export function decisionGatesEnabled(env: { KIMCHI_MEMORY_DECISION_GATE?: string | undefined }): ParsedGateFlags {
	return parseDecisionGateFlag(env.KIMCHI_MEMORY_DECISION_GATE)
}

// ---------------------------------------------------------------- criteria
// Texts validated by spike experiments (see REPORT.md). E5b fixed the
// triage/valuation framing; E6 extended digest criteria for dated events;
// E4's one miss added the opaque-identifiers clause to recall.

/** Window triage: should this window pay extraction at all? (E1/E1b/E5b/E6/E8) */
export function triageQuestion(): Record<"has_durable_fact", ChoiceQuestion> {
	return {
		has_durable_fact: {
			type: "choice",
			instructions:
				"Does this snippet contain at least one DURABLE fact worth capturing to long-term memory? Durable sources are: (a) USER-STATED facts — stable preferences, decisions with rationale, corrections, personal context (role, family, plans, possessions, constraints), itemized values (counts, prices, dates, measurements) — each occurrence of recurring items as its own fact; (b) ASSISTANT-PROVIDED answers the user engaged with — the user asked a question it answers, or accepted/acted on/referred back to it (schedules, rotations, recipes, recommendations, numbers); (c) plans and dated events. NOT durable: small talk with no fact content, code/file contents, generic advice the user never engaged with.",
			criteria: { yes: "At least one durable fact is present", no: "Nothing durable — only transient content" },
		},
	}
}

/** Fact valuation: keep this extracted fact? (E2/E6/E8) */
export const VALUATION_STATE =
	"A memory system extracted the following candidate facts from a user's assistant sessions. Judge each one independently for long-term value."

export function valuationQuestion(fact: string, index: number): ChoiceQuestion {
	return {
		type: "choice",
		instructions: `Candidate memory fact ${index + 1}: "${fact}" — should a long-term memory system KEEP this fact?`,
		criteria: {
			keep: "Durable from ANY source: user-stated (stable preference, decision with rationale, correction, personal context, possession with purpose, itemized value, dated event/plan) OR assistant-provided fact the user engaged with (asked, accepted, acted on, referred back: schedules, rotations, recipes, numbers, recommendations) OR lasting project convention",
			discard:
				"Transient: task progress, statuses, work summaries, tool output, or content with no identifiable fact a future session could use",
		},
	}
}

/** Valuation discard bar: below this the fact is kept (discards landed at ~0.9 confidence in E2). */
export const VALUATION_DISCARD_MIN_P = 0.9

/** Triage extraction bar: a window judged durable at or above this pays
 * extraction. 0.3 (not 0.4) is the LongMemEval-calibrated floor — chain
 * recall survived at 0.2/0.25/0.3 with the 87% skip rate; 0.35 started
 * dropping needle windows (E5b/E6). Change only with a calibration run. */
export const TRIAGE_DURABLE_MIN_P = 0.3

/** Digest selection (question-time with an opening prompt/request). (E3/E6/E8) */
export function digestState(request: string): string {
	return `The user asks: """${request}"""\nThe memory store holds the following remembered facts. Decide for each whether it belongs in the injected context.`
}

export function digestQuestion(fact: string, index: number): ChoiceQuestion {
	return {
		type: "choice",
		instructions: `Candidate memory fact ${index + 1}: "${fact}" — would injecting this fact into the session's context materially help answer the user's question?`,
		criteria: {
			inject:
				"Directly relevant: the fact changes the answer, prevents a mistake, answers part of the question, OR carries a date/value/name the question's reasoning needs (for questions comparing two events or items, inject facts for BOTH sides when present)",
			skip: "Unrelated, marginal, redundant with another selected fact, OR merely restates what the user just said (same-session echo)",
		},
	}
}

/** Turn-recall gating: is this turn worth an archive search? (E4) */
export function recallState(digestSummary: string, driftSignal: string): string {
	return `The assistant's session already holds these injected memory facts:\n${digestSummary || "(none injected)"}\n\nThe user's latest message (+ response tail) is:\n"""\n${driftSignal}\n"""`
}

export function recallQuestion(): Record<"lookup", ChoiceQuestion> {
	return {
		lookup: {
			type: "choice",
			instructions: "Would searching the memory archive for facts relevant to this message materially help answer it?",
			criteria: {
				search:
					"The message likely touches a topic the archive covers — it is NOT already covered by the injected facts listed above — OR references opaque identifiers/names (PR numbers, PIDs, project codenames) from earlier sessions",
				skip: "The message is a direct instruction fully answerable from the current conversation, code-centric, or already covered by injected facts",
			},
		},
	}
}

/** Supersede judging: does a new fact explicitly REPLACE this existing memory? (E7 Part A) */
export function supersedeState(newFacts: string[], candidates: Array<{ id: string; memory: string }>): string {
	return `NEW FACTS (chronological order):\n${newFacts.map((f) => `- ${f}`).join("\n")}\n\nEXISTING MEMORIES:\n${candidates.map((c) => `${c.id}: ${c.memory}`).join("\n")}`
}

export function supersedeQuestion(candidate: { id: string; memory: string }): ChoiceQuestion {
	return {
		type: "choice",
		instructions: `Should existing memory "${candidate.id.slice(0, 8)}" (${candidate.memory.slice(0, 100)}) be DELETED because a new fact explicitly changes, reverses, or updates the SAME value for the SAME subject? Rules: delete only on explicit changed-value evidence (counts, statuses, locations, preferences differing for the same subject). Complementary details are not replacements. When unsure, keep. A later dated fact supersedes an earlier dated one for the same subject. An identical or near-identical restatement is NOT a replacement.`,
		criteria: {
			delete: "A new fact explicitly replaces this memory's value for the same subject",
			keep: "Complementary detail, different subject/dimension, duplicate restatement, or uncertain — keep it",
		},
	}
}

/** Store consolidation: whole-store redundancy classification. (E7 Part B) */
export function consolidateState(facts: string[]): string {
	return `A personal memory store holds these ${facts.length} facts:\n${facts.map((f, i) => `${i + 1}. ${f}`).join("\n")}`
}

export function consolidateQuestion(fact: string, index: number): ChoiceQuestion {
	return {
		type: "choice",
		instructions: `Fact ${index + 1}: "${fact}" — considering ALL the listed memories, is this fact redundant?`,
		criteria: {
			unique: "Carries information no other listed memory carries",
			exact_twin: "Another listed memory says the same thing in the same or trivially different words",
			near_twin:
				"Another listed memory covers the same subject with substantially the same content, and keeping both adds nothing",
			complementary: "Overlaps with another memory but adds a distinct dimension (different aspect, scope, or detail)",
		},
	}
}
