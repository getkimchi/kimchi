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
import type { ChoiceAnswer, ChoiceQuestion } from "./decision-gate.js"
import { parseBooleanFlag } from "./flags.js"

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

/** Task-lane acceptance wording — appended ONLY when KIMCHI_MEMORY_TASK_SCOPE
 * is enabled; flag OFF keeps the criterion strings byte-identical to the
 * calibrated set below. Change only with a calibration run (module rule). */
const TASK_SCOPE_TRIAGE_SUFFIX =
	" (d) DURABLE TASK facts — exact schema/identifier mappings, unit or format conventions, confirmed traps with their corrections, and decisions the asker settled with rationale"
const TASK_SCOPE_VALUATION_KEEP_SUFFIX =
	" OR durable task knowledge (exact schema/identifier mapping, unit/format convention, confirmed trap + correction, settled decision rationale)"

/** Task-lane env flag, re-parsed per call — mirrors the other gate env reads. */
export function taskLaneEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return parseBooleanFlag(env, "KIMCHI_MEMORY_TASK_SCOPE")
}

/** Window triage: should this window pay extraction at all? (E1/E1b/E5b/E6/E8,
 * replaced by the multi-class fan-out after the 2026-11-12 live cross-corpus
 * experiment — see docs/memory-extension.md. The single has_durable_fact
 * question crushed assistant-side evidence-grounded conclusions
 * (p≈0.05–0.24 on tactical notes-to-self); splitting the durable definition
 * into per-class questions rescued exactly that class without regressing any
 * content the single question kept.)
 *
 * Four CONTENT classes decide keep/skip. A fifth question,
 * `insight_worth_future_self`, is recorded in the trace/dashboard but is
 * deliberately NOT gating: it over-fires on raw boilerplate (<skill> blocks,
 * unmined transcripts) when used as the decider.
 */
export type TriageQuestionName =
	| "user_stated_durable"
	| "engaged_assistant_answer"
	| "plan_or_dated_event"
	| "learned_conclusion"
	| "insight_worth_future_self"

/** The four classes that gate: skip only when ALL of them score below
 * TRIAGE_DURABLE_MIN_P. `insight_worth_future_self` is trace-only signal. */
export const TRIAGE_GATE_CLASSES = [
	"user_stated_durable",
	"engaged_assistant_answer",
	"plan_or_dated_event",
	"learned_conclusion",
] as const satisfies readonly TriageQuestionName[]

export type TriageGateClass = (typeof TRIAGE_GATE_CLASSES)[number]

/** All five names, including the trace-only signal — tests key off this set. */
export const TRIAGE_QUESTION_NAMES: ReadonlySet<string> = new Set([...TRIAGE_GATE_CLASSES, "insight_worth_future_self"])

export function triageQuestions(): Record<TriageQuestionName, ChoiceQuestion> {
	return {
		user_stated_durable: {
			type: "choice",
			instructions:
				"Does this snippet contain any USER-STATED durable fact: a stable preference, a decision with rationale, a correction, personal context (role, plans, possessions, constraints), or an itemized value (count, price, date, measurement)?" +
				(taskLaneEnabled()
					? `; also: TASK facts —${TASK_SCOPE_TRIAGE_SUFFIX.replace(" (d) DURABLE TASK facts —", "")}`
					: ""),
			criteria: { yes: "At least one user-stated durable fact", no: "None" },
		},
		engaged_assistant_answer: {
			type: "choice",
			instructions:
				"Does this snippet contain an assistant-provided answer or fact the USER actively engaged with (asked for, accepted, acted on, or referred back to) — e.g. schedules, rotations, recipes, recommendations, numbers the user needed?",
			criteria: { yes: "At least one engaged assistant answer", no: "None" },
		},
		plan_or_dated_event: {
			type: "choice",
			instructions: "Does this snippet contain a plan, a scheduled event, or a dated occurrence worth recalling later?",
			criteria: { yes: "At least one plan or dated event", no: "None" },
		},
		learned_conclusion: {
			type: "choice",
			instructions:
				"Does this snippet contain a CONCLUSION established from evidence during the session — a failure pattern identified, a procedure/approach validated or invalidated by its observed outcome, a verified mechanic/rule of the environment, or a tactical/strategic lesson — regardless of whether the user or the assistant stated it?",
			criteria: { yes: "At least one evidence-grounded conclusion", no: "None" },
		},
		insight_worth_future_self: {
			type: "choice",
			instructions:
				"Would any content in this snippet materially help an agent answering in a FUTURE session — something worth loading at the start of the next conversation to avoid repeating a mistake or losing established knowledge? (Judge content type: concrete lessons/facts yes, generic advice no.)",
			criteria: { yes: "Content worth recalling in a future session", no: "Nothing future-useful" },
		},
	}
}

/** Triage keep/skip decision from one d3 response. Skip only when every
 * gate class reports a numeric p(yes) below TRIAGE_DURABLE_MIN_P — a
 * response missing numeric answers degrades to NOT-skip (extraction on
 * unknowns, mirroring the pre-split undefined behavior).
 * `probabilities` mirrors the four classes (+ signal question) verbatim
 * for the drain trace: the dashboard renders which class carried a keep. */
export function triageVerdict(answers: Partial<Record<TriageQuestionName, ChoiceAnswer | undefined>>): {
	skip: boolean
	/** Max gate-class probability — the decisions' numeric anchor (undefined
	 * when no class answered numerically; skip is then false). */
	maxP: number | undefined
	/** The class that carried the keep (the argmax) — for trace labeling. */
	topClass: TriageGateClass | undefined
	probabilities: Partial<Record<TriageQuestionName, number>>
} {
	const probabilities: Partial<Record<TriageQuestionName, number>> = {}
	let maxP: number | undefined
	let topClass: TriageGateClass | undefined
	for (const name of TRIAGE_GATE_CLASSES) {
		const p = answers[name]?.probabilities.yes
		if (typeof p !== "number") continue
		probabilities[name] = p
		if (maxP === undefined || p > maxP) {
			maxP = p
			topClass = name
		}
	}
	const signal = answers.insight_worth_future_self?.probabilities.yes
	if (typeof signal === "number") probabilities.insight_worth_future_self = signal
	return { skip: maxP !== undefined && maxP < TRIAGE_DURABLE_MIN_P, maxP, topClass, probabilities }
}

/** Fact valuation: keep this extracted fact? (E2/E6/E8) */
export const VALUATION_STATE =
	"A memory system extracted these candidate facts from an agent's past sessions. Future sessions of this agent retrieve each memory by semantic similarity with their current task. Judge each fact on one dimension only: would knowing it in advance help a future session do its work better?"

/**
 * Env flag (KIMCHI_MEMORY_GATE_NOISE_CLASSES, default OFF): append the
 * empirically measured harness/evaluation protocol boilerplate class to
 * the valuation discard criteria. The class is content-free — it names a
 * *kind* of text (protocol meta, store-relevant nowhere), not any
 * benchmark's content: attempt/query limits, reply-format rules, question
 * numbering, and "the user is running an automated benchmark/evaluation"
 * self-references. OFF keeps the criteria bit-identical.
 */
export function gateNoiseClassesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return parseBooleanFlag(env, "KIMCHI_MEMORY_GATE_NOISE_CLASSES", { strict: true })
}

const GATE_NOISE_CLASS_SUFFIX =
	"; harness or evaluation protocol boilerplate (attempt/query limits, reply-format rules, question numbering, or statements that the user is running an automated benchmark or evaluation)"

/**
 * Env flag (KIMCHI_MEMORY_VALUATION_CONTEXT, default OFF): attach the
 * existing store's fact texts to the valuation state so the gate can see
 * what is already remembered — judging duplicates, conflicts, and
 * genuinely-new information with context instead of blind per-fact.
 */
export function valuationContextEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return parseBooleanFlag(env, "KIMCHI_MEMORY_VALUATION_CONTEXT", { strict: true })
}

/** Bound on existing-store facts attached to the valuation state. */
export const VALUATION_CONTEXT_MAX_FACTS = 100

/** Build the valuation state: the static prompt, plus (flagged) the store's
 * existing fact texts so discards/keeps can reference the live context. */
export function buildValuationState(existing?: string[]): string {
	if (!valuationContextEnabled() || !existing || existing.length === 0) return VALUATION_STATE
	const head = existing.slice(0, VALUATION_CONTEXT_MAX_FACTS)
	return `${VALUATION_STATE}\n\nThe store already holds these memories (use them to spot duplicates, conflicts, and genuinely-new information):\n${head.map((f) => `- ${f}`).join("\n")}`
}

export function valuationQuestion(fact: string, index: number): ChoiceQuestion {
	return {
		type: "choice",
		instructions: `Candidate memory fact ${index + 1}: "${fact}" — would knowing it in advance help a future session of this agent complete its task?`,
		criteria: {
			keep:
				"Durable from ANY source: user-stated (stable preference, decision with rationale, correction, personal context, possession with purpose, itemized value, dated event/plan) OR assistant-provided fact the user engaged with (asked, accepted, acted on, referred back: schedules, rotations, recipes, numbers, recommendations) OR lasting project convention" +
				(taskLaneEnabled() ? TASK_SCOPE_VALUATION_KEEP_SUFFIX : ""),
			discard:
				"Transient: task progress, statuses, work summaries, tool output, or content with no identifiable fact a future session could use" +
				(gateNoiseClassesEnabled() ? GATE_NOISE_CLASS_SUFFIX : ""),
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
