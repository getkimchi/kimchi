/**
 * The one-shot ferment's vocabulary, ported from kimchi.
 *
 * Everything here has a counterpart in the kimchi checkout, and the port is deliberately literal — a
 * field that exists there exists here, with the same name and the same LLM-visible description, because
 * the point of this workflow is to run the SAME instruction set through the engine instead of through
 * the ferment tool loop:
 *
 *  | here                    | kimchi                                                        |
 *  | ----------------------- | ------------------------------------------------------------- |
 *  | `planSchema`            | `ScopeParams` (src/extensions/ferment/tool-schemas.ts)         |
 *  | `refineSchema`          | `RefineParams`                                                 |
 *  | `workerReportSchema`    | `submit_agent_report` (src/extensions/agents/worker-report.ts) |
 *  | `stepGatesSchema` etc.  | `CompleteStepParams.gates` + the gate registry                 |
 *  | `GATE_REGISTRY`         | src/extensions/ferment/gate-registry.ts (verbatim)             |
 *  | `FERMENT_WORKER_BUDGETS`| src/extensions/agents/worker-budget-policy.ts (verbatim)       |
 *
 * What is NOT ported: `ferment_id` / `phase_id` / `step_id` and every other tool-call parameter whose
 * only job was to tell the ferment state machine which record a turn was addressing. The engine's data
 * flow already knows — that is the whole trade this workflow makes.
 *
 * The gate ids that a turn owns are pinned by the schema (a literal union per turn) rather than by
 * kimchi's `assertGateCoverage`, so a missing or misnamed gate is a schema violation the engine steers
 * on, instead of a tool error the model has to be told about.
 */
import { type Static, Type } from "typebox"

// -- Input -------------------------------------------------------------------------------------------

/**
 * The workflow's top-level input, validated by the extension against `--input @<file>` before the run
 * starts. The harbor adapter's envelope is `{"instruction": ...}` —
 * see `src/kimchi_agent/workflow_agent.py`'s `_pre_launch_commands` — so that is exactly the shape here.
 *
 * A copy rather than a shared import: the sibling `tb-solver.workflow.ts` (kimchi-workflows repo) still
 * declares its own `taskInputSchema` with a `deadlineIso` field, because `tb-solver`'s scheduling divides
 * a budget across its stages and needs a clock to divide. This workflow deliberately has no such
 * scheduling and never reads a deadline anywhere in its steps, so `deadlineIso` is dropped here rather
 * than carried as dead weight — a required field the adapter never sends would fail every run's input
 * validation before the first step even starts. The run is bounded by harbor's own agent-phase timeout
 * instead, which this workflow is never told about and does not need to be.
 */
export const taskInputSchema = Type.Object({
	/** The verbatim terminal-bench instruction. */
	instruction: Type.String(),
})

// -- Gates ------------------------------------------------------------------------------------------

/**
 * Ported verbatim from kimchi's `gate-registry.ts`: the question and the guidance are prompt text.
 *
 * **Verbatim includes the PERSON, and that is not a stylistic detail.** kimchi writes every gate in the
 * second person — "Read your own summary", "Classify your own verify command honestly", "would make your
 * work fail", "List anything you couldn't do". It is talking to the ORCHESTRATOR: the one long-running
 * ferment session that wrote the plan, DID this step's work, and is about to record its summary. That
 * agent owns the work and wants it to land; the gates are the honesty check it runs on itself before
 * advancing. Six live one-shot runs settle who that is — all 31 `complete_ferment_step` calls omitted
 * `worker_agent_id`, and the orchestrator session spent 108 `bash`, 16 `write` and 13 `edit` calls with
 * zero agent spawns. "Your own summary" is literal: it wrote the summary because it did the work.
 *
 * This port had rewritten the S gates (and F3) into the third person — "Read the step's summary", "the
 * verify command", "this work", "anything that could not be done". Same questions, different addressee:
 * an outside assessor asked whether SOMEONE ELSE'S work is sound. It behaves accordingly. Measured over
 * one live run: S3 flagged 21 times against 15 passes — it refused more often than it passed, on correct
 * work, once flagging a successful `pip install` because "a network outage would cause pip install to
 * fail and there is no offline fallback". Native kimchi over the same tasks: 32 steps, 1 retry, 6/6.
 *
 * The words are the mechanism. Do not paraphrase them.
 *
 * The only substitution left is a tool name with no counterpart here: kimchi's P3/F3 name the
 * `complete_ferment` tool, and this workflow's equivalent is the ship check (`ship`).
 */
export const GATE_REGISTRY = {
	P1: {
		id: "P1",
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
		question: "What evidence must the final ship check see to ship?",
		guidance: [
			"Declare the explicit checklist the ship check will validate against — files exist, tests pass, behavior demonstrated.",
			"This list is the contract C1 will walk at ship time. Vague entries here become uncatchable failures later.",
			"Cite the success criteria from the scope. If success criteria is empty, write one now.",
		].join("\n"),
	},
	S1: {
		id: "S1",
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
		question: "What edge case would break this step?",
		guidance: [
			"Name one concrete input or condition that would make your work fail.",
			"Empty input, malformed input, concurrent access, missing dependency, network failure — pick the most likely.",
			"Then state whether your work handles it. If not, that's a 'flag' — you've identified a known gap.",
			"'omitted' is only valid for steps with no externally-driven behavior (pure config edits, doc-only changes).",
		].join("\n"),
	},
	F1: {
		id: "F1",
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
		question: "Does the phase's combined output deliver the phase goal?",
		guidance: [
			"Restate the phase goal in one sentence, then map the union of step outputs to that goal.",
			"A phase where every step is done but the phase goal is still not met is a 'flag'.",
			"Cite the specific artifact (file, behavior, command output) that demonstrates the goal.",
		].join("\n"),
	},
	F3: {
		id: "F3",
		question: "What was left undone or deferred in this phase?",
		guidance: [
			"List anything you couldn't do, skipped, or deferred — by step or by intent.",
			"Be explicit. 'Nothing deferred' is a valid verdict only if it's actually true.",
			"Deferred items will be read by C2 at ship time. Hiding them here makes the ship gate fail later.",
			"Return 'pass' when nothing is deferred; 'flag' when items are deferred without explicit acceptance.",
		].join("\n"),
	},
	C1: {
		id: "C1",
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
		question: "Are there phases with unresolved F3 (left-undone) items?",
		guidance: [
			"Read every phase's F3 verdict.",
			"If a phase declared deferred items, either: (a) cite the later phase that resolved them, or (b) explicitly accept them as out-of-scope follow-ups.",
			"Unresolved deferrals without explicit acceptance are 'flag' — the work is incomplete.",
		].join("\n"),
	},
	C3: {
		id: "C3",
		question: "Did real verification ever execute the artifact, or is the work proxy-verified?",
		guidance: [
			"Read every S2 and F1 verdict across the ferment.",
			"If the entire chain is proxy/sentinel/syntactic, the work has never actually run — 'flag', refuse ship.",
			"Cite at least one step where verify was 'smoke' or 'test' and exercised the load-bearing artifact.",
		].join("\n"),
	},
} as const

export type GateId = keyof typeof GATE_REGISTRY

/** The gate ids a turn owns — kimchi's `ownerTurn` column, one row per completion turn. */
export const PLAN_GATES = ["P1", "P2", "P3"] as const
export const STEP_GATES = ["S1", "S2", "S3"] as const
export const PHASE_GATES = ["F1", "F2", "F3"] as const
export const SHIP_GATES = ["C1", "C2", "C3"] as const

/** kimchi's `renderGateGuidance(turn)`: the question + guidance block a completion turn is shown. */
export function renderGateGuidance(ids: readonly GateId[]): string {
	return ids
		.map((id) => `**${id}** — ${GATE_REGISTRY[id].question}\n${GATE_REGISTRY[id].guidance}`)
		.join("\n\n")
		.trimEnd()
}

/**
 * kimchi's `gateVerdictObject`, with the id narrowed to the turn's own gates. S2 keeps its
 * classification aliases, which kimchi normalizes (smoke/test/syntactic → pass, proxy/sentinel → flag);
 * {@link normalizeVerdict} does the same normalization here.
 */
const CANONICAL_VERDICTS = ["pass", "flag", "omitted"] as const
const STEP_VERDICTS = [...CANONICAL_VERDICTS, "smoke", "test", "syntactic", "proxy", "sentinel"] as const

function gateArray(ids: readonly GateId[], verdicts: readonly string[]) {
	return Type.Array(
		Type.Object({
			id: Type.Union(
				ids.map((id) => Type.Literal(id)),
				{ description: `Gate id. Required ids for this turn: ${ids.join(", ")}.` },
			),
			verdict: Type.Union(
				verdicts.map((verdict) => Type.Literal(verdict)),
				{
					description:
						"'pass' = the gate's question is answered affirmatively with concrete evidence. 'flag' = the gate identifies a real problem. 'omitted' = the gate does not apply (requires rationale). Use only pass | flag | omitted.",
				},
			),
			rationale: Type.String({
				description: 'One sentence justifying the verdict. Required for every verdict including "pass" and "omitted".',
			}),
			evidence: Type.String({
				description:
					"File:line, quoted diff line, command output, or 'n/a' for omitted gates. Empty evidence is rejected.",
			}),
		}),
		{
			minItems: ids.length,
			maxItems: ids.length,
			description: `One verdict per gate, exactly these ids: ${ids.join(", ")}. A 'flag' refuses advancement.`,
		},
	)
}

/** kimchi normalizes S2's classification vocabulary before deciding whether a gate blocks. */
export function normalizeVerdict(verdict: string): "pass" | "flag" | "omitted" {
	switch (verdict) {
		case "smoke":
		case "test":
		case "syntactic":
			return "pass"
		case "proxy":
		case "sentinel":
			return "flag"
		case "flag":
			return "flag"
		case "omitted":
			return "omitted"
		default:
			return "pass"
	}
}

/** kimchi's `hasBlockingFlag`: any flag refuses advancement, and drives the same retry path. */
export function hasBlockingFlag(gates: readonly { verdict: string }[] | undefined): boolean {
	return (gates ?? []).some((gate) => normalizeVerdict(gate.verdict) === "flag")
}

// -- The plan ----------------------------------------------------------------------------------------

/**
 * kimchi's step shape, plus the `budget_tier` its planner picks per step at `start_ferment_step`.
 *
 * The tier moves EARLIER rather than away: there is no per-step planner turn here to choose it at
 * dispatch time (that turn is exactly the orchestration the engine replaces), so the plan carries it and
 * the step turn's prompt states it. The wording is kimchi's own, including "never infer it from
 * description keywords" — and so is its force: it describes the work's shape, and nothing enforces it
 * (see {@link FERMENT_WORKER_BUDGETS}).
 */
const stepSchema = Type.Object({
	description: Type.String(),
	verify: Type.Optional(Type.String({ description: "bash command that exits 0 on success" })),
	budget_tier: Type.Optional(
		Type.Union([Type.Literal("narrow"), Type.Literal("standard"), Type.Literal("complex")], {
			description:
				"Worker budget selected by scoped work shape: narrow for verification or one small edit; standard for normal implementation (default); complex for multi-file builds or iterative debugging. Select it from the scoped work shape; never infer it from description keywords.",
		}),
	),
})

/** kimchi's `PhaseProposalSchema`, minus `parallel_group` — see the workflow header on why phases run sequentially. */
const phaseSchema = Type.Object({
	name: Type.String(),
	goal: Type.String(),
	description: Type.Optional(Type.String()),
	constraints: Type.Optional(Type.Array(Type.String())),
	steps: Type.Array(stepSchema, {
		description:
			"Step breakdown for this phase — 1-4 steps, each with a description and, where possible, a verify command.",
	}),
})

/** kimchi's `ScopingQuestionSchema`. In one-shot mode these go to the judge, never to a human. */
const questionSchema = Type.Object({
	id: Type.String({ description: "Stable identifier for this question." }),
	type: Type.Optional(
		Type.Union([Type.Literal("single"), Type.Literal("multi"), Type.Literal("text"), Type.Literal("confirm")], {
			description:
				"Question style: 'single' (one choice, default), 'multi' (multiple choices), 'text' (enter-your-own answer only), or 'confirm' (yes/no).",
		}),
	),
	question: Type.String({
		description:
			"Canonical question sentence. Do not ask preference-survey questions when a safe default can be assumed; a request to be thorough with questions does not make default choices decision-blocking.",
	}),
	options: Type.Optional(
		Type.Array(Type.Object({ id: Type.String(), label: Type.String(), recommended: Type.Optional(Type.Boolean()) }), {
			description:
				"2-5 concrete options for single/multi questions. Omit for text and confirm questions (confirm is always Yes/No). At most ONE option per question may be recommended.",
		}),
	),
})

/** kimchi's `ScopeParams`, minus `ferment_id`. */
export const planSchema = Type.Object({
	title: Type.String({ description: "Required concise 3-5 word title for this ferment." }),
	goal: Type.String({ description: "The ferment goal — what the task asks for, in one sentence." }),
	success_criteria: Type.Array(Type.String(), {
		minItems: 1,
		description: "Observable acceptance criteria. Each item must be one concrete, verifiable criterion.",
	}),
	constraints: Type.Optional(
		Type.Array(Type.String(), { description: "Technical constraints implied by the intent." }),
	),
	assumptions: Type.Optional(
		Type.String({
			description:
				"A single concise prose paragraph covering all upfront assumptions the plan rests on. If an assumption is later found false, record it and continue rather than stopping.",
		}),
	),
	phases: Type.Array(phaseSchema, {
		minItems: 1,
		maxItems: 7,
		description:
			"1-7 ordered phases. Default to ONE phase for simple tasks and put setup, implementation, persistence, filtering, polish, and verification in that phase's steps. Add another phase only for a real vertical slice/tracer bullet, materially different complexity/risk tier, independent parallel workstream, or distinct code locality. Do not create phases just for setup, directory creation, CRUD vs polish, deciding scope, writing the plan, or to make the plan look organized. If questions is non-empty, keep phases answer-agnostic and provisional.",
	}),
	questions: Type.Array(questionSchema, {
		maxItems: 3,
		description:
			"Emit ONLY for decision-blocking uncertainty where the answer materially changes architecture, dependencies, data model, user-facing scope, security posture, deployment/runtime assumptions, or verification strategy. At most 3. Do not ask about defaults you can safely choose. Empty array when nothing is decision-blocking.",
	}),
	gates: gateArray(PLAN_GATES, CANONICAL_VERDICTS),
})

/** kimchi's `RefineParams.steps` — only reached for a phase the plan left with no steps. */
export const refineSchema = Type.Object({
	steps: Type.Array(stepSchema, { minItems: 1, description: "3-6 concrete steps for this phase." }),
})

/** One planned step, as the workflow passes it around. */
export type PlannedStep = Static<typeof stepSchema>
export type PlannedPhase = Static<typeof phaseSchema>

/**
 * What a `.foreach` hands its body: the item itself, declared so the body's first step can
 * validate it and every later step in that item can read it back by name.
 */
export const phaseItemSchema = Type.Object({ index: Type.Number(), total: Type.Number(), phase: phaseSchema })
export const stepItemSchema = Type.Object({ index: Type.Number(), total: Type.Number(), step: stepSchema })
export type PhaseItem = Static<typeof phaseItemSchema>
export type StepItem = Static<typeof stepItemSchema>

/** What running a step's verify command produced — kimchi's `StepResult`, minus the persistence fields. */
export const verifyResultSchema = Type.Object({
	ran: Type.Boolean({
		description:
			"False when the command never ran: the step declared none, or the completion self-flagged and kimchi refuses such a call before it reaches verification.",
	}),
	command: Type.String(),
	exitCode: Type.Number(),
	stdout: Type.String(),
	stderr: Type.String(),
})
export type VerifyResult = Static<typeof verifyResultSchema>

// -- Per-turn outputs -------------------------------------------------------------------------------

/**
 * kimchi's `submit_agent_report` parameters, unchanged — a dispatched worker's final structured report.
 *
 * One reader is left: the phase rework, which is the only turn in this workflow still handed to an agent
 * of its own. A step no longer produces one, because a step is no longer dispatched — the orchestrator
 * does the work and answers {@link stepGatesSchema} for it, which is the payload kimchi's own one-shot
 * runs produce.
 */
export const workerReportSchema = Type.Object({
	status: Type.Union([Type.Literal("completed"), Type.Literal("partial"), Type.Literal("blocked")], {
		description:
			'A completed report must use remaining_steps: []. Use "partial" if work remains, "blocked" if something stopped you.',
	}),
	summary: Type.String(),
	steps_completed: Type.Array(Type.String()),
	remaining_steps: Type.Array(Type.String(), {
		description: "Empty for a completed report; at least one entry for a partial one.",
	}),
	files_touched: Type.Optional(Type.Array(Type.String())),
	verification: Type.Optional(Type.Array(Type.String())),
	blockers: Type.Optional(Type.Array(Type.String(), { description: "At least one entry for a blocked report." })),
	notes: Type.Optional(Type.String()),
})

/**
 * kimchi's `CompleteStepParams`, minus the ids and the `worker_agent_id` that turns out never to be set.
 *
 * `worker_agent_id` is worth a paragraph, because it settles WHO does a step and who answers for it. It
 * is OPTIONAL — "Omit when the orchestrator executed the step directly (no subagent was spawned)" — and
 * `validateLinkedWorker` (tools/steps.ts:146) skips its checks outright "when worker_agent_id is omitted,
 * the orchestrator executed the step directly". `start_ferment_step` offers the choice in so many words:
 * "Either spawn a subagent … or execute the step directly using bash/edit/write. … If you executed
 * directly, call complete_ferment_step with just the summary and gates".
 *
 * One-shot ferment takes the second branch, always. Across six live native runs every one of the 31
 * `complete_ferment_step` calls omitted `worker_agent_id`, and the orchestrator session itself made 108
 * `bash`, 16 `write` and 13 `edit` calls and spawned no agent at all. So this payload is written by the
 * agent that did the work, about the work it just did — which is why the registry's second person reads
 * as it does, and why the port's step turn is one agent rather than a worker plus a reviewer.
 */
export const stepGatesSchema = Type.Object({
	summary: Type.String({ description: "Short summary of what this step accomplished, for the steps that follow it." }),
	gates: gateArray(STEP_GATES, STEP_VERDICTS),
})

/** kimchi's `complete_ferment_phase` gate payload. */
export const phaseGatesSchema = Type.Object({
	summary: Type.String({ description: "What this phase accomplished, in one or two sentences." }),
	gates: gateArray(PHASE_GATES, CANONICAL_VERDICTS),
})

/** kimchi's `complete_ferment` gate payload. */
export const shipGatesSchema = Type.Object({
	summary: Type.String({ description: "What the ferment delivered, in one or two sentences." }),
	gates: gateArray(SHIP_GATES, CANONICAL_VERDICTS),
})

/**
 * kimchi's phase grader reply (`judgePhaseGradeViaSubagent` → `parseGraderResponse`).
 *
 * This one is NOT advisory, and that is easy to misread: the docstring on `graderSpawner` says judge
 * *failure* modes are advisory, while the grade itself drives advancement — "A/B advance, C/D/F refuse
 * and route through the existing MAX_BLOCK_RETRIES / escalation loop" (judge.ts).
 */
export const phaseGradeSchema = Type.Object({
	grade: Type.Union([Type.Literal("A"), Type.Literal("B"), Type.Literal("C"), Type.Literal("D"), Type.Literal("F")]),
	rationale: Type.String(),
	recommendations: Type.Array(Type.String(), {
		description:
			"Concrete fixes that would reach an A. Each entry says what is wrong, why it matters, what must change, and what evidence would prove the fix. Empty for an A.",
	}),
})
export type PhaseGrade = Static<typeof phaseGradeSchema>

/** kimchi's `MAX_BLOCK_RETRIES` (state.ts): reworks a refused phase gets before the grade is accepted anyway. */
export const MAX_BLOCK_RETRIES = 3

/** kimchi's bar: an A on the first attempt, a B once the phase has been reworked (`minimumAcceptableGrade`). */
export function minimumAcceptableGrade(priorRetries: number): "A" | "B" {
	return priorRetries === 0 ? "A" : "B"
}

const GRADE_ORDER: Record<string, number> = { A: 5, B: 4, C: 3, D: 2, F: 1 }

/** True when the grader's verdict is below the bar for this attempt — kimchi's `judgeRefused`. */
export function gradeRefuses(grade: string | undefined, priorRetries: number): boolean {
	if (grade === undefined) return false // judge unavailable is advisory: it does NOT refuse advancement
	return (GRADE_ORDER[grade] ?? 0) < (GRADE_ORDER[minimumAcceptableGrade(priorRetries)] ?? 0)
}

/** kimchi's `ASK_USER_FORM_MAX_ATTEMPTS`: tries at the judge before falling back to defaults. */
export const ASK_USER_FORM_MAX_ATTEMPTS = 3

/**
 * kimchi's `defaultAnswerForQuestion`, ported verbatim in behaviour.
 *
 * The point is that an unreachable judge must not leave a decision unmade: "this prevents transient
 * judge failures from killing a ferment run". Confirm defaults to yes, single/multi to the first option
 * (the agent listed them in priority order), text to an explicit non-answer.
 */
export function defaultAnswerForQuestion(question: {
	id: string
	type?: string
	options?: readonly { id: string; label: string }[]
}): { id: string; value: string } {
	if (question.type === "confirm") return { id: question.id, value: "yes" }
	const first = question.options?.[0]
	if ((question.type === "single" || question.type === "multi") && first) return { id: question.id, value: first.id }
	return { id: question.id, value: "(no answer — judge was unavailable)" }
}

/** kimchi's `askJudgeForm` reply: `{"answers":[{"id":...,"value":...}],"rationale":"..."}`. */
export const judgeAnswersSchema = Type.Object({
	answers: Type.Array(Type.Object({ id: Type.String(), value: Type.String() })),
	rationale: Type.String({ description: "One sentence justifying the answers." }),
})

/** kimchi's `judgeStepVerification` reply — verbatim, including the fail-safe bias. */
export const verifyTriageSchema = Type.Object({
	verdict: Type.Union([Type.Literal("pass"), Type.Literal("retry"), Type.Literal("fail")]),
	reason: Type.String({ description: "One sentence." }),
})

// -- Budgets ----------------------------------------------------------------------------------------

/**
 * kimchi's `FERMENT_WORKER_BUDGETS`, verbatim (src/extensions/agents/worker-budget-policy.ts).
 *
 * **These numbers are ADVICE here, not boxes, and that is what kimchi does with them too.** Its
 * `limitsHint` is appended to every `start_ferment_step` result regardless of which branch the
 * orchestrator takes, and on the branch it actually takes — executing the step itself — there is no
 * `Agent` call for "set all three execution limits exactly on the Agent call" to apply to. The tier
 * describes the shape of the work ("narrow for verification or one small edit … complex for multi-file
 * builds"), and the only thing that ever stops the turn is the run's own deadline. So the tier is
 * rendered into the step turn's prompt exactly as kimchi renders it, and nothing enforces it.
 *
 * An earlier version of this port DID enforce it, as `maxDurationMs` on a dispatched worker step, and
 * grew a tier ladder to escalate a worker killed at its cap. Both are gone with the worker: there is no
 * separate process to box when the orchestrator does the work in its own session.
 *
 * `cumulativeTokenBudget` has no counterpart either: it bounded a worker plus its resumptions.
 */
export const FERMENT_WORKER_BUDGETS = {
	narrow: { maxTurns: 10, maxDuration: 180, tokenBudget: 50_000 },
	standard: { maxTurns: 25, maxDuration: 300, tokenBudget: 100_000 },
	complex: { maxTurns: 30, maxDuration: 600, tokenBudget: 150_000 },
} as const

export type BudgetTier = keyof typeof FERMENT_WORKER_BUDGETS

export function budgetTier(tier: string | undefined): BudgetTier {
	return tier === "narrow" || tier === "complex" ? tier : "standard"
}
