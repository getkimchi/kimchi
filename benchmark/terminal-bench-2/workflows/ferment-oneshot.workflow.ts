/**
 * kimchi's one-shot ferment, as a workflow: plan → (phase → (step → verify)* → phase gates)* → ship.
 *
 * This is the ALTERNATIVE to `tb-solver.workflow.ts` (kimchi-workflows repo, `benchmarks/terminal-bench/`),
 * and it is a different bet. `tb-solver` was designed from measured terminal-bench failures and owes
 * kimchi nothing. This one owes kimchi everything: it is a 1:1 rendering of what `kimchi --ferment-oneshot`
 * does — the same planning process, the same P/S/F/C gate registry, the same budget tiers, the same judge
 * standing in for the user, the same verification triage — with exactly one thing removed.
 *
 * ## What is removed, and why it is the whole point
 *
 * In kimchi the ferment lifecycle runs inside ONE session. The model is holding the plan, the phase, the
 * step it is in the middle of doing and the gate verdicts it is about to give, all at once, and after
 * every tool call it has to choose to keep going. When it doesn't, the extension makes it: `maybeInjectFermentStopNudge` re-sends the next
 * action when a turn ends early, `scheduleNextFermentAction` renders "call start_ferment_step now" with
 * the ids filled in, `maybeInjectScopingProgressNudge` counts exploration turns, the lifecycle
 * obligation guard catches text-only stops, and the one-shot envelope carries a "## Turn discipline"
 * section telling it not to stall. That machinery is not decoration — dropping the scope nudge alone
 * accounted for 16 of 31 scored failures in one terminal-bench run.
 *
 * None of it is needed here. The engine decides what runs next, so a step that "stops early" has simply
 * finished; there is no turn to nudge, no lifecycle to remind anyone of, and no way to stall between
 * stages. Every prompt in `ferment/prompts.ts` therefore keeps kimchi's instruction text and drops its
 * orchestration text (see that file's header for the line-by-line provenance).
 *
 * ## The other differences, all forced, all small
 *
 * The point of this workflow is that the ONLY interesting variable is engine-vs-session, so everything
 * below is a difference the medium forces, not a design choice — and there is deliberately no scheduling
 * policy of any kind (see "Budgets").
 *
 *  - **Phases and steps run sequentially.** kimchi's `parallel_group` is dropped from the plan schema
 *    rather than silently ignored: a `.foreach` above concurrency 1 requires non-overlapping side
 *    effects, which two agents editing one container's filesystem cannot promise.
 *  - **`budget_tier` moves into the plan.** kimchi picks it per step at `start_ferment_step`; that turn
 *    is orchestration, so the tier is chosen once, at plan time, in the planner's own words. It is
 *    ADVICE in the prompt at both ends — see "Budgets".
 *  - **Structured output replaces tool calls.** A gate payload that was a `complete_ferment_step`
 *    argument is now the step's output schema; the engine validates and steers on it.
 *  - **Every agent step is `optional`.** In kimchi a failing turn is a tool error the session survives;
 *    here the equivalent is a step whose failure does not take the run down with it.
 *
 * ## The worker that was here, and why it is gone
 *
 * Until now this file dispatched a `worker` subagent per step and had a separate turn rule on its report.
 * **kimchi's one-shot ferment dispatches nobody.** `start_ferment_step` offers both branches in so many
 * words — "Either spawn a subagent … or execute the step directly using bash/edit/write. … If you
 * executed directly, call complete_ferment_step with just the summary and gates (worker_agent_id is
 * optional)" — and six live native runs take the second one every time: all 31 `complete_ferment_step`
 * calls with `worker_agent_id` absent, and the orchestrator session itself spending 108 `bash`, 16
 * `write` and 13 `edit` calls, with zero agent spawns.
 *
 * So a step is ONE agent turn on the orchestrator's own session: it does the work with its tools and then
 * answers S1/S2/S3 about that work. The gate registry's second person stops being a courtesy and becomes
 * a fact — "Read **your own** summary" is addressed to the agent that wrote it because it did the work.
 *
 * Three pieces of machinery went with the worker, and all three were sound repairs to a shape kimchi does
 * not have. They are recorded here rather than quietly deleted, because each was added on measurement:
 *
 *  - the **tier box** (`maxDurationMs` from `FERMENT_WORKER_BUDGETS`), the **landing instruction** ("STOP
 *    WORKING AT Ns AND WRITE YOUR REPORT") and the **kill-and-escalate** ladder (`tierForAttempt`,
 *    `escalateTier`, `worker-landing`). All three existed because a dispatched subagent killed at its cap
 *    returns NOTHING — 46.0 min of one 6-task run went that way, 6 of 11 workers on a single task. There
 *    is no separate process to kill when the orchestrator does the work in its own session, so there is
 *    nothing to box, nothing to land inside, and nothing to escalate;
 *  - the **gate box** (`STEP_GATE_MAX_MS = 180s`), added because a gate turn that was a tool call in
 *    kimchi had become a subagent here and one had run 1472s against a p75 of 57s. The turn it was boxing
 *    no longer exists as a separate turn;
 *  - the **step diff block** (`step-diff`), which pasted a gathered diff into a gate turn that had not
 *    seen the work — 92.4 min of gate turns over that run, against 23 min if each had cost its own task's
 *    fastest. The reader has now made the edits itself, and what it gets instead is the one thing kimchi
 *    gives its orchestrator: the step's start ref (`stepStartRefs`, "consumed at complete_ferment_step for
 *    diff evidence", surfaced as a SHA in `derive-state.ts`). kimchi assembles a step diff for nobody.
 *
 * ## Shape
 *
 *   scoping = (plan → judge?)*                          until the plan has phases and no open questions
 *   phases  = foreach phase
 *               refine?                                 only a phase the plan left with no steps
 *               steps = foreach step
 *                         (step turn → gate check → verify → triage? → check)*
 *               close = (rework? → F gates → grade? → decide)*
 *   ship    = the C gates                               once every phase is terminal
 *
 * The loops are where a ferment's "refuses advancement" lives, and they are NOT the same refusal. Reading
 * them as one is the single most expensive mistake this port has made:
 *
 *  - a flagged S gate refuses ONE COMPLETION and nothing else. kimchi is explicit: "Step-level flags
 *    don't feed the phase retry/escalation pipeline - they just refuse this single call, and the agent
 *    has to fix the underlying issue and re-call" (tools/steps.ts:427). Nothing is recorded and the
 *    verification never runs — "Gate validation runs BEFORE any state mutation" — and the step turn is
 *    re-entered on its own session holding kimchi's refusal text, where it may work some more before
 *    answering again. That is the same conversation continuing, not a second opinion being bought;
 *  - a verification the triage judge calls real sends the STEP back, into that same session, told what
 *    the command actually printed (kimchi's rule: "a bounded direct continuation … do not raise the
 *    limits and retry the same broad task");
 *  - a PHASE that clears its F gates then has to clear the grader as well — A/B advance, C/D/F refuse
 *    and buy a rework, up to `MAX_BLOCK_RETRIES` times, after which the grade is accepted and the phase
 *    advances anyway. This is the piece of kimchi that is easiest to mistake for a report: the letter
 *    grade drives control flow, and an earlier version of this file omitted it entirely.
 *
 * The first two used to be two nested loops, because one re-ran a cheap gate turn and the other bought a
 * fresh cold worker. Both are now the same act — re-enter the session that did the work — so they are one
 * loop with one counter, and what differs is only what the turn is told and whether the verification is
 * reached.
 */
import { type Static, Type } from "typebox"
import { createAgentStep, createStep, createWorkflow, type RunContext } from "@kimchi-dev/kimchi-workflows"
import {
	ASK_USER_FORM_MAX_ATTEMPTS,
	budgetTier,
	defaultAnswerForQuestion,
	FERMENT_WORKER_BUDGETS,
	gradeRefuses,
	hasBlockingFlag,
	judgeAnswersSchema,
	MAX_BLOCK_RETRIES,
	minimumAcceptableGrade,
	normalizeVerdict,
	type PhaseGrade,
	type PhaseItem,
	type PlannedStep,
	phaseGatesSchema,
	phaseGradeSchema,
	phaseItemSchema,
	planSchema,
	refineSchema,
	type StepItem,
	shipGatesSchema,
	stepGatesSchema,
	stepItemSchema,
	taskInputSchema,
	verifyResultSchema,
	verifyTriageSchema,
	workerReportSchema,
} from "./ferment/contract.ts"
import {
	type FailedVerification,
	journeyGraderPrompt,
	judgePrompt,
	phaseGatesPrompt,
	phaseGraderPrompt,
	phaseReworkPrompt,
	planPrompt,
	refinePrompt,
	shipPrompt,
	stepTurnPrompt,
	verifyTriagePrompt,
} from "./ferment/prompts.ts"
import { currentGitRef, type DiffEvidence, phaseDiffSince, runVerification } from "./ferment/verify.ts"

type Task = Static<typeof taskInputSchema>
type Plan = Static<typeof planSchema>
type JudgeAnswers = Static<typeof judgeAnswersSchema>
type StepGates = Static<typeof stepGatesSchema>
type PhaseGates = Static<typeof phaseGatesSchema>
type VerifyResult = Static<typeof verifyResultSchema>
type Triage = Static<typeof verifyTriageSchema>

// -- Budgets -----------------------------------------------------------------------------------------
//
// NOTHING here is sized from what is left. A ferment runs until the work is done; it never divides a
// budget across its stages, never sizes a turn from the remaining clock, and never tells a model how much
// of the run it may have. Adding any of that would be inventing scheduling policy kimchi does not have,
// and a first run of this workflow showed exactly what that costs: per-stage boxes fed on what earlier
// stages had spent, so `phase-gates` was granted 307ms and `ship` a NEGATIVE box — the two closing gate
// turns never ran, and the ship verdict was decided by arithmetic instead of by evidence.
//
// **A step turn now carries no wall clock at all, and that is the deliberate cost of the merge.** kimchi
// bounds this turn with nothing but the run's own deadline: `complete_ferment_step` is a tool call inside
// a session the harness owns, and the work before it is that same session's tool calls. There is no
// second process to box once the orchestrator does the work, so boxing it would be inventing a bound
// kimchi does not have — which is what the old `worker` tier box and `STEP_GATE_MAX_MS` were, honestly
// arrived at and no longer applicable. The tier survives as PROMPT TEXT, exactly as kimchi's `limitsHint`
// survives on the branch where no Agent is ever spawned.
//
// What that buys, stated plainly: a step turn that runs away now spends the RUN's clock rather than its
// own, and the phases behind it get less. That is the same exposure kimchi carries, at the same level.
//
// The single deadline that does exist is harbor's own agent-phase timeout,
// and this workflow is never told what it is and computes nothing from it — there used to be an
// in-process `extension.ts` that read `TB_AGENT_TIMEOUT_SEC`, built its own deadline and aborted the run
// a safety margin before the harness would kill it; that adapter is gone (the workflow now starts via the
// ordinary `/workflow run ferment-oneshot` command surface), and harbor does not hand this deadline to any
// non-oracle agent to begin with. What replaces it is the same protection kimchi itself relies
// on: harbor cancels the agent phase from outside the container when its own `[agent] timeout_sec` fires,
// `Kimchi.run` catches that cancellation and terminates the recorded process group, and the container is
// graded in whatever state that leaves it — the whole run bounded from the outside, not the individual
// turn, and not by anything this workflow tracks.
//
// One constant box is left in this file, on `phase-rework` — the only turn still handed to an agent of
// its own rather than taken by the orchestrator — and it is kimchi's own `standard` tier, not a share of
// anything.

/**
 * Sessions here follow one rule: **share a session when it is the same actor continuing its own work;
 * stay cold when the point is a second opinion.**
 *
 * kimchi puts ALL orchestrator turns in one session and compacts it. Compaction is disabled here, so a
 * single session cannot hold the whole run — the background-bash tool's checkin round-trips inflated a
 * shared step-turn session to 260K+ tokens, 14,926 lines and 148 `ContextWindowExceededError`s on one
 * build-pov-ray trial. The split below keeps continuity exactly where it is cheap and load-bearing.
 *
 * The steps holding either key run strictly sequentially (no `.foreach` here exceeds concurrency 1),
 * which is what makes sharing legal: `.commit()` rejects a shared key on anything that can overlap,
 * because two subagents appending to one session file would interleave into nonsense.
 */

/**
 * The two lightweight gate turns, `phase-gates` and `ship`.
 *
 * Both are the orchestrator answering FOR ITS OWN WORK — written in the second person throughout the
 * registry ("your own summary", "the P3 checklist declared at scope time"). Neither runs bash, so the
 * session stays small. C3's "every S2 and F1 verdict across the ferment" is a question about a record
 * this session helped write.
 */
const ORCHESTRATOR_SESSION = "orchestrator"

/**
 * The planner's own conversation, across every scoping round and every later refinement.
 *
 * The scoping loop is kimchi's interview — ask, hear the judge, replan — and without a shared session
 * round two is a cold start that meets its own prior questions as pasted text. `refine-steps` holds the
 * same key because breaking a phase into steps is the same act as planning it, done later; it should
 * read the plan it is extending rather than a summary of it.
 *
 * `judge` deliberately does NOT hold this key. It stands in for the user (kimchi routes `ask_user` to it
 * in one-shot mode), so it has to answer from the questions alone — a judge sharing the planner's
 * reasoning is the planner agreeing with itself.
 *
 * Cheap by construction: planning turns are prompts and structured replies, no tool work.
 */
const PLANNING_SESSION = "planning"

/**
 * A resume key naming ONE step of one phase — the per-execution form of `resumable` (spec §2.2).
 *
 * `resumable: true` keys by the step's NAME, which is the same for every item of a `.foreach`, so it
 * would pool every step of every phase into one session. This keys on the item instead, which is what
 * makes "each step continues its own conversation, and nothing wider" expressible at all.
 *
 * Deliberately NOT including the attempt: spanning the attempt loop is the entire point — a step sent
 * back after a refused gate or a failed verification has to meet its own edits and the refusal, not a
 * summary of them. Deliberately not including the run either; `resumeSessionFile` carries no run
 * component by design, so a key that did would be describing something the filename cannot hold.
 *
 * Falls back to `0-0` only if the addressing is wrong, which would be a bug in this file rather than a
 * state a run can reach — and a stable wrong key is far easier to spot in a session directory than a
 * silent cold start would be.
 */
const stepSessionKey =
	(role: string) =>
	({ ctx }: { ctx: RunContext }): string => {
		const phase = ctx.getStepResult<PhaseItem>("phase-ctx")?.index ?? 0
		const step = ctx.getStepResult<StepItem>("step-ctx")?.index ?? 0
		return `${role}-p${phase}-s${step}`
	}

/**
 * How many times a step's turn may run: the refusals of its completion and the continuations after a
 * failed verification, counted together because they are now the same act.
 *
 * kimchi caps NEITHER — "step-level flags don't feed the phase retry/escalation pipeline, they just
 * refuse this single call", and the orchestrator re-calls until it passes, or resolves the step
 * explicitly with skip/fail. Neither of those exists as a turn in this workflow, so some bound is
 * unavoidable; it borrows `MAX_BLOCK_RETRIES`, the only retry budget kimchi actually defines, rather
 * than inventing a second number.
 *
 * It was 2, chosen when a refusal re-ran a cold subagent that could never change its mind. It then became
 * two nested budgets, one per loop. It is one number again because there is one loop again: the same
 * session is re-entered either way, so `STEP_MAX_ATTEMPTS` re-entries is the whole of a step's budget
 * rather than one factor of a product.
 */
const STEP_MAX_ATTEMPTS = MAX_BLOCK_RETRIES

const intentOf = (ctx: RunContext): string => ctx.getInitData<Task>()?.instruction ?? "(missing)"

/**
 * A read whose absence can only mean a WIRING bug, not a step that was skipped.
 *
 * The engine's data flow has one genuinely sharp edge: a mis-addressed `getStepResult` returns
 * `undefined`, which is indistinguishable from "that step has not run yet" (only an
 * in-flight read throws). Defaulting such a read is how a bug survives a whole run: `phase-result` read
 * the F verdicts and the grade by bare name from outside the closing loop, got `undefined`, substituted
 * "(no phase summary)" / "(ungraded)", and `ship` was handed an empty table without anything failing.
 *
 * So reads that CANNOT legitimately be empty — the item a foreach handed this body, a function step
 * that has no failure mode — go through here and fail loudly instead.
 */
function mustRead<T>(ctx: RunContext, nameOrPath: string, why: string): T {
	const value = ctx.getStepResult<T>(nameOrPath)
	if (value === undefined) {
		throw new Error(
			`getStepResult("${nameOrPath}") is undefined, but ${why}. This is an addressing bug, not a skipped step.`,
		)
	}
	return value
}

// -- Names shared between a branch and its readers ---------------------------------------------------

const JUDGE_ARM = "judge-round"
const REFINE_ARM = "refine-phase"
const TRIAGE_ARM = "verify-triage"
const REWORK_ARM = "phase-rework-round"
const GRADE_ARM = "phase-grade-round"

// -- Scoping ----------------------------------------------------------------------------------------

type ScopeCheck = {
	ready: boolean
	plan: Plan | undefined
	asked: { id: string; question: string }[]
	answers: JudgeAnswers | undefined
}

const scopeCheckSchema = Type.Object({
	ready: Type.Boolean(),
	plan: Type.Optional(planSchema),
	asked: Type.Array(Type.Object({ id: Type.String(), question: Type.String() })),
	answers: Type.Optional(judgeAnswersSchema),
})

/**
 * The best plan so far, carried into this round.
 *
 * It has to be carried rather than re-read: a step may not observe itself, and `plan` is
 * `optional`, so a round whose planner failed would otherwise erase a usable plan an earlier round had
 * already produced.
 */
const scopeCarry = createStep({
	name: "scope-carry",
	description: "The plan carried into this scoping round",
	output: Type.Object({ plan: Type.Optional(planSchema) }),
	run: ({ ctx }) => ({ plan: ctx.getStepResult<ScopeCheck>("scoping/scope-check")?.plan }),
})

const plan = createAgentStep({
	name: "plan",
	description: "Scope the intent into a ferment plan: goal, criteria, phases, steps, gates",
	output: planSchema,
	background: true,
	// A second round is a REPLAN with the judge's answers in hand, not a fresh start — so it continues the
	// conversation that produced round one rather than reading its own prior questions as pasted text.
	// That is kimchi's interview, which is one session there for the same reason.
	//
	// NOT the orchestrator's key: the planner must not accumulate the implementation work's context (see
	// PLANNING_SESSION). The prompt still carries the questions and answers explicitly, because a resumed
	// session is continuity and not a substitute for saying what changed.
	resumable: PLANNING_SESSION,
	optional: true,
	retry: { maxRetry: 0 },
	prompt: ({ ctx }) => {
		const previous = ctx.getStepResult<ScopeCheck>("scope-check")
		return planPrompt({ intent: intentOf(ctx), answers: previous?.answers, questionsAsked: previous?.asked })
	},
})

/**
 * The judge standing in for the user (kimchi's `askJudgeForm`). One-shot scoping still runs the
 * interview — it just routes it to a model that decides, because there is nobody to ask.
 */
const judge = createAgentStep({
	name: "judge",
	description: "Answer the planner's decision-blocking questions as the user would",
	output: judgeAnswersSchema,
	background: true,
	optional: true,
	// kimchi loops the judge call up to ASK_USER_FORM_MAX_ATTEMPTS, re-sending it with "your previous
	// response was not valid or did not match the expected schema" appended, and only then falls back to
	// defaults. A `background` step cannot be steered in-session, so repair is
	// not possible — the equivalent is a fresh attempt per retry, which is what
	// kimchi's loop does anyway.
	//
	// Measured: without this, a judge that answered in prose ("I have al…") failed the step outright and
	// the planner's question went permanently unanswered.
	retry: { maxRetry: ASK_USER_FORM_MAX_ATTEMPTS - 1 },
	prompt: ({ ctx }) => judgePrompt({ intent: intentOf(ctx), plan: ctx.getStepResult<Plan>("plan") }),
})

const judgeRound = createWorkflow({ name: JUDGE_ARM }).then(judge).commit()

/** Whether the interview runs at all: exactly kimchi's rule — it runs when the planner asked something. */
const wantsJudge = (ctx: RunContext): boolean => (ctx.getStepResult<Plan>("plan")?.questions?.length ?? 0) > 0

const scopeCheck = createStep({
	name: "scope-check",
	description: "Is the plan ready to run",
	output: scopeCheckSchema,
	run: ({ ctx, logger }) => {
		const drafted =
			ctx.getStepResult<Plan>("plan") ?? ctx.getStepResult<{ plan: Plan | undefined }>("scope-carry")?.plan
		const judged = ctx.getStepResult<Record<string, JudgeAnswers | undefined>>("interview")?.[JUDGE_ARM]
		const questions = drafted?.questions ?? []
		const asked = questions.map((question) => ({ id: question.id, question: question.question }))

		// kimchi's fallback: when the judge is unreachable after every attempt it does NOT proceed with the
		// question unanswered — it answers on the judge's behalf with conservative defaults, "rather than
		// abandoning the ferment". A question that reaches the planner unanswered is the one outcome the
		// one-shot interview is built to avoid, so the same substitution happens here.
		const answers =
			judged ??
			(questions.length > 0
				? {
						answers: questions.map(defaultAnswerForQuestion),
						rationale: `Judge was unavailable after ${ASK_USER_FORM_MAX_ATTEMPTS} attempts; using conservative defaults.`,
					}
				: undefined)

		// Ready means what `scope_ferment` means in kimchi: a plan with phases and nothing still being
		// asked. An unanswered question is what another round is FOR — and since the fallback above always
		// produces answers, a round that asked always gets one more round to fold them in.
		const hasPlan = (drafted?.phases?.length ?? 0) > 0
		const ready = hasPlan && !(asked.length > 0 && answers !== undefined)
		logger.info("scoping round finished", {
			hasPlan,
			questions: asked.length,
			answeredBy: judged ? "judge" : answers ? "defaults" : "none",
			ready,
		})
		return { ready, plan: drafted, asked, answers }
	},
})

const scopeRound = createWorkflow({ name: "scope-round" })
	.then(scopeCarry)
	.then(plan)
	.branch([[wantsJudge, judgeRound]], { name: "interview" })
	.then(scopeCheck)
	.commit()

// -- One step ---------------------------------------------------------------------------------------

const stepCtx = createStep({
	name: "step-ctx",
	description: "The step this item is about",
	input: stepItemSchema,
	output: stepItemSchema,
	run: ({ input }) => input,
})

type StepCheck = {
	done: boolean
	attempt: number
	index: number
	description: string
	summary: string
	verdicts: string
	verified: string
	/**
	 * The verify command itself, not just the rendered line about it.
	 *
	 * The closing loop re-runs this for any step that did not settle. It has to, because the step loop is
	 * OUTSIDE the closing loop: `steps` is fixed by the time the first closing turn starts, so a rework
	 * could never change a `done: false` and the phase would refuse forever on a stale record. Empty for a
	 * step with no verification command.
	 */
	command: string
	/**
	 * True when THIS is why the step did not settle: the command ran and exited non-zero.
	 *
	 * Kept apart from the other two reasons a step fails (a flagged gate, a turn that returned nothing)
	 * because only this one can be re-asked. Re-running a command proves something about a verification
	 * failure and nothing at all about a turn that never spoke — a step that went silent while its verify
	 * command happens to exit 0 is not a step anybody verified.
	 */
	blockedOnVerification: boolean
	reason: string
	flags: { id: string; rationale: string; evidence: string }[]
}

const stepCheckSchema = Type.Object({
	done: Type.Boolean(),
	attempt: Type.Number(),
	index: Type.Number(),
	description: Type.String(),
	summary: Type.String(),
	verdicts: Type.String(),
	verified: Type.String(),
	command: Type.String(),
	blockedOnVerification: Type.Boolean(),
	reason: Type.String(),
	flags: Type.Array(Type.Object({ id: Type.String(), rationale: Type.String(), evidence: Type.String() })),
})

/**
 * Which attempt at this step this is. Read at the TOP of the attempt, because a step may not observe
 * itself — `step-check` cannot count its own attempts.
 *
 * The read is a BARE name on purpose: an explicit path is absolute, and this loop lives
 * under whichever phase and step item it is nested in, so `attempts/step-check` would address a node
 * that exists at the root and resolve to nothing at all. A bare name resolves lexically, to this item's
 * own previous iteration.
 *
 * It used to sample a wall clock too, which `worker-landing` read to infer whether a dispatched worker
 * had been killed at its cap. Nothing is dispatched and nothing is capped, so there is no kill to infer.
 */
const attemptClock = createStep({
	name: "attempt-clock",
	description: "Which attempt at this step this is",
	output: Type.Object({ attempt: Type.Number() }),
	run: ({ ctx }) => ({ attempt: (ctx.getStepResult<StepCheck>("step-check")?.attempt ?? 0) + 1 }),
})

const planOf = (ctx: RunContext): Plan | undefined => ctx.getStepResult<ScopeCheck>("scoping/scope-check")?.plan

/**
 * The steps of this phase that already ran, with what they reported — kimchi's `Prior:` line.
 *
 * Addressed item by item rather than through the enclosing `.foreach`'s output, which does not exist
 * until every item has finished. Foreach item indices survive into the static key while loop iteration
 * indices do not, so `phases@1/steps@0/attempts/step-check` names item 0's LAST attempt —
 * exactly the record kimchi keeps on the step.
 */
const priorStepsOf = (
	ctx: RunContext,
	phaseIndex: number,
	stepIndex: number,
): { index: number; description: string; summary: string }[] => {
	const prior: { index: number; description: string; summary: string }[] = []
	for (let item = 0; item < stepIndex - 1; item++) {
		const result = ctx.getStepResult<StepCheck>(`phases@${phaseIndex - 1}/steps@${item}/attempts/step-check`)
		if (result?.done) prior.push({ index: result.index, description: result.description, summary: result.summary })
	}
	return prior
}

const tierOf = (step: PlannedStep | undefined) => budgetTier(step?.budget_tier)

/**
 * The step: kimchi's `start_ferment_step`, the work, and `complete_ferment_step`, in the one turn that
 * does all three.
 *
 * ## Who does the work, and the reading that got this wrong twice
 *
 * kimchi offers its orchestrator two branches at `start_ferment_step`: "Either spawn a subagent … or
 * execute the step directly using bash/edit/write. … If you executed directly, call
 * complete_ferment_step with just the summary and gates (worker_agent_id is optional)". One-shot ferment
 * takes the direct branch every time — 31 of 31 completions across six live runs with `worker_agent_id`
 * absent, 108 `bash` / 16 `write` / 13 `edit` calls made by the orchestrator session itself, 0 spawns.
 *
 * This port modelled the other branch, and paid for it twice over. First it made the gate turn an
 * INDEPENDENT cold reviewer, on the argument that S1 ("does the summary describe work present in the
 * diff?") is "only a real question when you have not written the summary yourself" — which measured 30
 * refusals in 33 step attempts across five runs, the S gates never once passing a step they had already
 * flagged. Then it kept a dispatched worker and merely resumed the reviewer, which fixed the refusals but
 * left a whole extra agent, its box, its landing instruction and its escalation ladder in place — every
 * one of them machinery for a subagent kimchi never spawns.
 *
 * So this is ONE agent step: it does the work with its tools, then answers S1/S2/S3 about what it did.
 * That is what makes the registry's second person literally true — "Read your own summary" is addressed
 * to the agent that wrote the summary because it did the work — and it is why a flag can be refused
 * straight back here (`gate-check`): resolving it is this agent's own turn, in this conversation, with
 * the same tools it used the first time.
 *
 * ## One session PER STEP, and why neither of the other two options works
 *
 * A re-entered step must meet its own work. kimchi's refusal goes "straight back into the conversation"
 * — the agent re-entering has its edits, its verdicts and the refusal text, and can act on all three.
 * Handing it a summary instead is the "chain of briefed strangers" this whole file argues against.
 *
 * But it must NOT be one session for every step. Sharing across steps is what produced 14,926 lines and
 * 148 `ContextWindowExceededError`s on a single build-pov-ray trial: compaction is disabled here, and a
 * single `apt-get install` under the background-bash tool generates 10–20 `bash_control` checkin
 * round-trips, so an all-steps session accumulates without bound.
 *
 * `resumable: true` cannot say "per step" — it keys by the step's NAME, and every item of the `.foreach`
 * runs this same named step, so all of them would pool into one file: exactly the shape above. Hence the
 * per-execution key. Scoped to the phase AND the step index, so the conversation spans the attempt loop
 * (where continuity is the point) and nothing wider.
 *
 * Sequential by construction — `.foreach` here never exceeds concurrency 1 — and the host refuses two
 * concurrent claims on one resume file, so a key that forgot the index would fail loudly rather than
 * interleave two steps' conversations.
 *
 * No `maxDurationMs`: there is no separate process to box, and kimchi bounds this turn with nothing
 * but the run's deadline (see "Budgets").
 */
const stepTurn = createAgentStep({
	name: "step-turn",
	description: "Do this step's work, then answer the step-scope gates on what you did",
	output: stepGatesSchema,
	background: true,
	resumable: stepSessionKey("step"),
	optional: true,
	retry: { maxRetry: 0 },
	prompt: ({ ctx }) => {
		const phase = ctx.getStepResult<PhaseItem>("phase-ctx")
		const item = ctx.getStepResult<StepItem>("step-ctx")
		const attempt = ctx.getStepResult<{ attempt: number }>("attempt-clock")?.attempt ?? 1
		const last = ctx.getStepResult<StepCheck>("step-check")
		// The verification this step has already been through, which exists only from the SECOND attempt on:
		// kimchi runs the verify command inside `complete_ferment_step`, AFTER the gates, and a refused call
		// never reaches it at all. Reordering it to feed a first attempt would change what a refusal costs.
		const verified = ctx.getStepResult<VerifyResult>("verify")
		return stepTurnPrompt({
			plan: planOf(ctx),
			phaseIndex: phase?.index ?? 1,
			phaseCount: phase?.total ?? 1,
			phase: phase?.phase ?? { name: "(unknown)", goal: "(unknown)" },
			stepIndex: item?.index ?? 1,
			stepCount: item?.total ?? 1,
			step: item?.step ?? { description: "(missing)" },
			tier: tierOf(item?.step),
			priorSteps: priorStepsOf(ctx, phase?.index ?? 1, item?.index ?? 1),
			startRef: ctx.getStepResult<{ ref: string }>("step-start-ref")?.ref,
			// Everything a re-entry needs and nothing it already has: the session is resumed, so this says only
			// what changed. `flags` picks the refusal branch, which is kimchi's gate error; anything else is the
			// step itself coming back.
			previous:
				attempt > 1 && last
					? { reason: last.reason, flags: last.flags, verify: verified?.ran === true ? verified : undefined }
					: undefined,
		})
	},
})

type GateCheck = {
	refused: boolean
	summary: string
	verdicts: string
	flags: { id: string; rationale: string; evidence: string }[]
}

const gateCheckSchema = Type.Object({
	refused: Type.Boolean(),
	summary: Type.String(),
	verdicts: Type.String(),
	flags: Type.Array(Type.Object({ id: Type.String(), rationale: Type.String(), evidence: Type.String() })),
})

/**
 * kimchi's gate validation, which runs at the TOP of `completeStep` and before any state mutation: a
 * flagged verdict refuses this one call and nothing else happens — no verification, no step record.
 *
 * "Step-level flags don't feed the phase retry/escalation pipeline - they just refuse this single call,
 * and the agent has to fix the underlying issue and re-call" (tools/steps.ts:427). Re-calling is exactly
 * what the next iteration of this loop does, into the session that flagged.
 *
 * A turn that produced NOTHING has no verdicts, so `hasBlockingFlag(undefined)` is false and this is not
 * a refusal — the step is decided on its verification alone, with the gate record reading "(none)" for
 * `phase-gates` (F1 reads every step's S2) and the grader to see. That is how every unreachable judge in
 * this port is read: advisory, never a refusal.
 */
const gateCheck = createStep({
	name: "gate-check",
	description: "Does this completion stand, or is it refused back to the same session",
	output: gateCheckSchema,
	run: ({ ctx, logger }) => {
		const gates = ctx.getStepResult<StepGates>("step-turn")
		const flags = (gates?.gates ?? [])
			.filter((gate) => normalizeVerdict(gate.verdict) === "flag")
			.map((gate) => ({ id: gate.id, rationale: gate.rationale, evidence: gate.evidence }))

		const refused = hasBlockingFlag(gates?.gates)
		logger.info("completion turn finished", { refused, flags: flags.map((flag) => flag.id) })
		return {
			refused,
			summary: gates?.summary ?? "(no summary)",
			verdicts: (gates?.gates ?? []).map((gate) => `${gate.id}:${gate.verdict}`).join(" ") || "(none)",
			flags,
		}
	},
})

/**
 * kimchi runs the step's verify command itself, inside `complete_ferment_step`. So does this — and at
 * the same point in the turn, which is AFTER the gates: "Gate validation runs BEFORE any state
 * mutation" (tools/steps.ts:427). A refused call never reaches the verification, so neither does this.
 */
const verify = createStep({
	name: "verify",
	description: "Run the step's verification command and record what it did",
	output: verifyResultSchema,
	optional: true,
	run: async ({ ctx, abortSignal, logger }) => {
		const notRun = { ran: false, command: "", exitCode: 0, stdout: "", stderr: "" }
		if (ctx.getStepResult<GateCheck>("gate-check")?.refused === true) return notRun
		const command = ctx.getStepResult<StepItem>("step-ctx")?.step.verify?.trim()
		if (!command) return notRun
		const result = await runVerification(command, abortSignal)
		logger.info("verification finished", { command, exitCode: result.exitCode })
		return result
	},
})

const verifyFailed = (ctx: RunContext): boolean => {
	const result = ctx.getStepResult<VerifyResult>("verify")
	return result?.ran === true && result.exitCode !== 0
}

/**
 * One conversation per step, across that step's attempts.
 *
 * It is asked the same question repeatedly about the same step — attempt 2's failure follows attempt
 * 1's — and "is this the failure I already classified, or a new one?" is only answerable by a judge that
 * remembers. Cheap to keep: kimchi runs this as a single call with NO tools ("do not re-run the command
 * or inspect the machine — classify what you are shown"), so the session is a prompt and a verdict, not
 * a transcript of tool work. That is what separates it from the graders below, which have tools and stay
 * cold.
 */
const triage = createAgentStep({
	name: "verify-judge",
	description: "Classify a non-zero verification exit as benign, transient, or a real defect",
	output: verifyTriageSchema,
	background: true,
	resumable: stepSessionKey("triage"),
	optional: true,
	retry: { maxRetry: 0 },
	prompt: ({ ctx }) => {
		const item = ctx.getStepResult<StepItem>("step-ctx")
		const result = ctx.getStepResult<VerifyResult>("verify")
		return verifyTriagePrompt({
			step: item?.step ?? { description: "(missing)" },
			command: result?.command ?? "",
			exitCode: result?.exitCode ?? 1,
			stdout: result?.stdout ?? "",
			stderr: result?.stderr ?? "",
		})
	},
})

const triageRound = createWorkflow({ name: TRIAGE_ARM }).then(triage).commit()

/**
 * kimchi's `completeStep`, as a decision rather than a tool call — same order, same precedences:
 * a blocking gate flag refuses the completion; then a turn that produced nothing refuses it; then the
 * verification decides, with a non-zero exit going to triage whose silence reads as `fail`.
 *
 * The refusals are NOT interchangeable even though they now share a loop. A flag is refused BEFORE
 * anything is recorded and before the verification runs at all, and what it asks for is a fix and a
 * re-vote; a failed verification is the step itself coming back, with the command's output to work from.
 * `reason` and `flags` are what tell the next turn which of the two it is looking at.
 */
const stepCheck = createStep({
	name: "step-check",
	description: "Decide whether this step is done, or is re-entered",
	output: stepCheckSchema,
	run: ({ ctx, logger }) => {
		const item = ctx.getStepResult<StepItem>("step-ctx")
		const attempt = ctx.getStepResult<{ attempt: number }>("attempt-clock")?.attempt ?? 1
		const completion = ctx.getStepResult<GateCheck>("gate-check")
		const gates = ctx.getStepResult<StepGates>("step-turn")
		const verified = ctx.getStepResult<VerifyResult>("verify")
		const verdict = ctx.getStepResult<Record<string, Triage | undefined>>("triage")?.[TRIAGE_ARM]

		const flags = completion?.flags ?? []

		const verifiedLine = verified?.ran
			? verified.exitCode === 0
				? `exit 0 (${verified.command})`
				: `exit ${verified.exitCode} (${verified.command}) — triage: ${verdict?.verdict ?? "fail (no verdict)"}`
			: completion?.refused === true
				? "not run — the completion was refused before verification"
				: "no verification command"

		let done = true
		let blockedOnVerification = false
		let reason = "gates passed and verification held"
		if (completion?.refused === true) {
			done = false
			reason = `a step gate flagged: ${flags.map((flag) => flag.id).join(", ")}`
		} else if (gates === undefined) {
			// The turn produced nothing at all — no summary, no verdicts, so nothing was done that anyone can
			// account for. kimchi's session would be nudged to try the step again; here that is the next
			// iteration, which resumes the same conversation.
			done = false
			reason = "the step turn returned nothing — no summary and no gate verdicts"
		} else if (verified?.ran && verified.exitCode !== 0) {
			// kimchi's fail-safe: anything other than a clearly parsed "pass" is a failure, and a judge that
			// never answered is not a pass.
			const triaged = verdict?.verdict ?? "fail"
			if (triaged === "pass") {
				reason = `verification exited ${verified.exitCode} but triage passed it: ${verdict?.reason}`
			} else {
				done = false
				blockedOnVerification = true
				reason = `verification failed (exit ${verified.exitCode}): ${verdict?.reason ?? "no triage verdict — treating as failure"}`
			}
		}

		logger.info("step attempt finished", { step: item?.index, attempt, done, reason })

		return {
			done,
			attempt,
			index: item?.index ?? 0,
			description: item?.step.description ?? "(missing)",
			summary: completion?.summary ?? "(no summary)",
			verdicts: completion?.verdicts ?? "(none)",
			verified: verifiedLine,
			command: verified?.ran ? verified.command : "",
			blockedOnVerification,
			reason,
			flags,
		}
	},
})

/**
 * One attempt at a step, and kimchi's own order inside `completeStep`: the gates first, because "Gate
 * validation runs BEFORE any state mutation", then the verification the gates guard.
 *
 * This used to be two nested loops — an inner one that re-voted the gates alone, and an outer one that
 * re-dispatched the worker. With one agent doing both, both loops are the same act (re-enter the session
 * that did the work), so there is one loop, one counter, and no way for a step to cost the product of
 * two budgets.
 */
const stepAttempt = createWorkflow({ name: "attempt" })
	.then(attemptClock)
	.then(stepTurn)
	.then(gateCheck)
	.then(verify)
	.branch([[verifyFailed, triageRound]], { name: "triage" })
	.then(stepCheck)
	.commit()

/**
 * A step ends when it is done, or when it has had its attempts.
 *
 * A flag no longer ends it. That rule was here because going round again meant re-running a WORKER, which
 * is the one thing kimchi never does for a flag — it refuses a single tool call. Going round now means
 * re-entering the session that flagged, holding kimchi's refusal text, which is precisely what kimchi's
 * orchestrator does. A step that leaves this loop still flagged is simply not done, and the F gates and
 * the phase grader read it that way.
 */
const stepSettled = (last: StepCheck): boolean => last.done || last.attempt >= STEP_MAX_ATTEMPTS

/**
 * The commit this STEP starts from — kimchi's `stepStartRef`, captured at `start_ferment_step` and
 * "consumed at complete_ferment_step for diff evidence" (runtime-state-store.ts:11).
 *
 * Outside the attempt loop deliberately: a second attempt continues the first one's work, so the range
 * has to cover both. Anchored per step rather than per phase for the same reason in reverse — S1 asks
 * whether THIS step's summary is in the diff, and a phase-wide range would drag in every earlier step.
 *
 * The SHA is all that is handed over, which is all kimchi hands over (`derive-state.ts:150`). The agent
 * reading it made the edits itself; `git diff <ref>` is one command, and a version of this file that
 * gathered the diff and pasted it in was serving a reader that no longer exists.
 */
const stepStartRef = createStep({
	name: "step-start-ref",
	description: "The commit this step starts from",
	output: Type.Object({ ref: Type.String() }),
	optional: true,
	run: async ({ abortSignal }) => ({ ref: await currentGitRef(abortSignal) }),
})

const stepBody = createWorkflow({ name: "step" })
	.then(stepCtx)
	.then(stepStartRef)
	.dountil(stepAttempt, (_ctx, last) => stepSettled(last as StepCheck), {
		name: "attempts",
		maxIterations: STEP_MAX_ATTEMPTS + 1,
	})
	.commit()

// -- One phase --------------------------------------------------------------------------------------

const phaseCtx = createStep({
	name: "phase-ctx",
	description: "The phase this item is about",
	input: phaseItemSchema,
	output: phaseItemSchema,
	run: ({ input }) => input,
})

/**
 * kimchi's `refine_ferment_phase`, reached by the same rule its engine uses (`determineNextAction`
 * case 7: an active phase with no steps). A one-shot plan normally arrives with steps, so this arm is
 * skipped — it exists because a plan that omits them would otherwise silently run an empty phase.
 */
const refineSteps = createAgentStep({
	name: "refine-steps",
	description: "Break a phase with no steps into concrete ones",
	output: refineSchema,
	background: true,
	// Breaking a phase into steps is planning, done later — so it continues the planner's conversation and
	// extends the plan it helped write, rather than re-deriving intent from a phase name and a goal line.
	resumable: PLANNING_SESSION,
	optional: true,
	retry: { maxRetry: 0 },
	prompt: ({ ctx }) => {
		const item = ctx.getStepResult<PhaseItem>("phase-ctx")
		return refinePrompt({
			intent: intentOf(ctx),
			plan: planOf(ctx),
			phaseIndex: item?.index ?? 1,
			phaseCount: item?.total ?? 1,
			phase: item?.phase ?? { name: "(unknown)", goal: "(unknown)" },
		})
	},
})

const refineRound = createWorkflow({ name: REFINE_ARM }).then(refineSteps).commit()

const needsRefine = (ctx: RunContext): boolean =>
	(ctx.getStepResult<PhaseItem>("phase-ctx")?.phase.steps?.length ?? 0) === 0

const stepSelector = (ctx: RunContext): readonly StepItem[] => {
	const refined = ctx.getStepResult<Record<string, Static<typeof refineSchema> | undefined>>("refine")?.[REFINE_ARM]
	const steps = refined?.steps ?? ctx.getStepResult<PhaseItem>("phase-ctx")?.phase.steps ?? []
	return steps.map((step, index) => ({ index: index + 1, total: steps.length, step }))
}

const phaseGates = createAgentStep({
	name: "phase-gates",
	description: "Answer the phase-scope gates on what the phase actually delivered",
	output: phaseGatesSchema,
	background: true,
	optional: true,
	retry: { maxRetry: 0 },
	// kimchi's `complete_ferment_phase` — the same orchestrator turn again, so the same session. F1 asks it
	// to "read the S2 verdicts from every step in this phase", which are verdicts it gave itself. The
	// step verdicts are passed via `ctx.getStepResult` (not session memory), so this step does not need
	// to share a session with `step-turn`. It DOES share with `ship` via `ORCHESTRATOR_SESSION` — both are
	// lightweight (no bash work) and benefit from seeing each other's context.
	resumable: ORCHESTRATOR_SESSION,
	prompt: ({ ctx }) => {
		const item = ctx.getStepResult<PhaseItem>("phase-ctx")
		const steps = (ctx.getStepResult<(StepCheck | undefined)[]>("steps") ?? []).filter(
			(step): step is StepCheck => step !== undefined,
		)
		return phaseGatesPrompt({
			plan: planOf(ctx),
			phaseIndex: item?.index ?? 1,
			phaseCount: item?.total ?? 1,
			phase: item?.phase ?? { name: "(unknown)", goal: "(unknown)" },
			steps,
		})
	},
})

/**
 * The phase grader (kimchi's `judgePhaseGradeViaSubagent`), and the thing that makes a phase's closing
 * turn a decision rather than a formality: after the F gates pass, an independent grader assigns A–F
 * and **A/B advance while C/D/F refuse**.
 *
 * kimchi spawns it as a subagent WITH tools ("verify the agent's claims independently"), unlike its two
 * plain-API judges, so a background agent step is the faithful shape here rather than a compromise. It
 * is `optional` for the same reason kimchi treats an unreachable judge as advisory: a grader that never
 * answered must not block a phase (`gradeRefuses` reads `undefined` as no refusal).
 */
const phaseGrade = createAgentStep({
	name: "phase-grade",
	description: "Grade the completed phase A-F against what the machine actually shows",
	output: phaseGradeSchema,
	background: true,
	optional: true,
	retry: { maxRetry: 0 },
	prompt: ({ ctx }) => {
		const item = ctx.getStepResult<PhaseItem>("phase-ctx")
		const gates = ctx.getStepResult<PhaseGates>("phase-gates")
		const steps = (ctx.getStepResult<(StepCheck | undefined)[]>("steps") ?? []).filter(
			(step): step is StepCheck => step !== undefined,
		)
		const diff = ctx.getStepResult<DiffEvidence>("phase-diff")
		return phaseGraderPrompt({
			plan: planOf(ctx),
			phase: item?.phase ?? { name: "(unknown)", goal: "(unknown)" },
			phaseSummary: gates?.summary ?? "",
			stepSummaries: steps
				.map(
					(step) =>
						`  ${step.index}. "${step.description}" [${step.done ? "settled" : "UNSETTLED"}] — ${step.summary} [${step.verified}]`,
				)
				.join("\n"),
			gateVerdicts: gates?.gates ?? [],
			diff: diff ?? { available: false, filesChanged: "", diffSnippet: "", elidedBytes: 0 },
			cwd: process.cwd(),
			// The re-run exit codes, so the grader cannot certify a phase whose commands are failing as it
			// reads them. Without this the block below is dead code, which is exactly what it was.
			failedVerifications: failedVerificationsOf(ctx),
			// What this grader asked for last round, WITHOUT the reasoning that produced it. Read straight off
			// the previous closing turn: `close-clock` exists only because `phase-close` cannot read ITSELF,
			// and this is a different step, so the bare key already names the last accepted close. Undefined
			// on the first closing turn, which is the one with nothing to check against.
			prior: (() => {
				const previous = ctx.getStepResult<PhaseClose>("phase-close")?.grade
				return previous ? { grade: previous.grade, recommendations: previous.recommendations ?? [] } : undefined
			})(),
		})
	},
})

/**
 * Every step of this phase that the attempt loop finished, in the order the plan gave them.
 *
 * Readable from inside the closing loop as well as outside it — `phase-gates` already reads it this way.
 */
const settledStepsOf = (ctx: RunContext): StepCheck[] =>
	(ctx.getStepResult<(StepCheck | undefined)[]>("steps") ?? []).filter((step): step is StepCheck => step !== undefined)

const reverifySchema = Type.Object({
	checks: Type.Array(
		Type.Object({
			index: Type.Number(),
			description: Type.String(),
			command: Type.String(),
			exitCode: Type.Number(),
			passing: Type.Boolean(),
			output: Type.String(),
		}),
	),
})
type Reverify = Static<typeof reverifySchema>

/**
 * Re-run the verification of every step that did NOT settle, at the top of each closing turn.
 *
 * This is the port's stand-in for the one thing kimchi's state machine gives it for free. There, a failed
 * verification is `fail_step` (`tools/steps.ts`) and the step carries a `failed` status from then on, so
 * every later reader — the phase grader's step summaries, the review-evidence sidecar, the ship-time
 * judge — sees it. Here a step's outcome was a return value that `phase-close` did not read, and the
 * grader's own record of it was a bracket at the end of a summary line.
 *
 * Re-running rather than remembering is what makes the refusal ACTIONABLE. The step loop sits outside the
 * closing loop, so `steps` never changes again; a refusal keyed on the remembered `done: false` could not
 * be cleared by the rework it triggers, and would just burn the whole retry budget before advancing
 * anyway. Re-running asks the machine the same question again, which is the only question a rework can
 * change the answer to.
 *
 * Only steps that HAVE a verify command are re-run. A step that failed on a gate flag or an empty turn is
 * still reported (it shows up in the step counts the ship check and the journey grader read), but it is
 * not treated as a deterministic block: there is no command whose exit code could settle it, so blocking
 * on it would refuse the phase for something no rework could ever clear. Those stay with F1/F2, which is
 * where kimchi leaves them too.
 */
const phaseReverify = createStep({
	name: "phase-reverify",
	description: "Re-run the verification of every step that did not settle",
	output: reverifySchema,
	run: async ({ ctx, abortSignal, logger }) => {
		const unsettled = settledStepsOf(ctx).filter((step) => step.blockedOnVerification && step.command !== "")
		const checks = []
		for (const step of unsettled) {
			const result = await runVerification(step.command, abortSignal)
			checks.push({
				index: step.index,
				description: step.description,
				command: step.command,
				exitCode: result.exitCode,
				passing: result.exitCode === 0,
				// The tail is what carries the failing assertion; the head is usually setup noise.
				output: `${result.stdout}${result.stderr}`.slice(-1200),
			})
		}
		logger.info("re-verified unsettled steps", {
			checked: checks.length,
			stillFailing: checks.filter((check) => !check.passing).length,
		})
		return { checks }
	},
})

/** The still-failing re-runs, in the shape the grader and the rework are shown. */
const failedVerificationsOf = (ctx: RunContext): FailedVerification[] =>
	(ctx.getStepResult<Reverify>("phase-reverify")?.checks ?? [])
		.filter((check) => !check.passing)
		.map((check) => ({
			step: check.index,
			description: check.description,
			command: check.command,
			exitCode: check.exitCode,
			reason: check.output.trim() || "(no output)",
		}))

/** What changed in this phase, as evidence for the grader — kimchi's phase-start ref plus its diff. */
const phaseStartRef = createStep({
	name: "phase-start-ref",
	description: "The commit this phase starts from",
	output: Type.Object({ ref: Type.String() }),
	optional: true,
	run: async ({ abortSignal }) => ({ ref: await currentGitRef(abortSignal) }),
})

const phaseDiff = createStep({
	name: "phase-diff",
	description: "What this phase changed, for the grader",
	output: Type.Object({
		available: Type.Boolean(),
		filesChanged: Type.String(),
		diffSnippet: Type.String(),
		elidedBytes: Type.Number(),
	}),
	optional: true,
	run: async ({ ctx, abortSignal }) =>
		phaseDiffSince(ctx.getStepResult<{ ref: string }>("phase-start-ref")?.ref ?? "", abortSignal),
})

type PhaseClose = {
	accepted: boolean
	/**
	 * How the phase actually ended, kept apart from `accepted` on purpose.
	 *
	 * `accepted` is the loop's exit signal and nothing more — the closing loop has to terminate, and a
	 * `dountil` that never accepts just runs out of iterations and advances silently, which is the shape
	 * this whole fix exists to remove. `outcome` is the RECORD: "completed" for a phase that closed clean,
	 * "failed" for one that ran out of retries with a gate flagged or a verification still exiting
	 * non-zero. kimchi keeps the same distinction as a phase status, and its ship-time judge reads it.
	 */
	outcome: "completed" | "failed"
	retry: number
	grade: PhaseGrade | undefined
	refused: boolean
	minimum: string
	flags: { id: string; rationale: string; evidence: string }[]
	failedVerifications: FailedVerification[]
	/** Identifies THIS refusal, so a closing turn that changed nothing can be recognised as such. */
	failureHash: string
}

const phaseCloseSchema = Type.Object({
	accepted: Type.Boolean(),
	outcome: Type.Union([Type.Literal("completed"), Type.Literal("failed")]),
	retry: Type.Number(),
	grade: Type.Optional(phaseGradeSchema),
	refused: Type.Boolean(),
	minimum: Type.String(),
	flags: Type.Array(Type.Object({ id: Type.String(), rationale: Type.String(), evidence: Type.String() })),
	failedVerifications: Type.Array(
		Type.Object({
			step: Type.Number(),
			description: Type.String(),
			command: Type.String(),
			exitCode: Type.Number(),
			reason: Type.String(),
		}),
	),
	failureHash: Type.String(),
})

/**
 * kimchi's `judgeRefused` branch, as a decision: below the bar the phase does not complete and the
 * agent is handed the recommendations to address (bounded by `MAX_BLOCK_RETRIES`, after which the grade
 * is accepted and the phase advances anyway — "the agent had its retries; we don't block continuation
 * indefinitely").
 */
const phaseClose = createStep({
	name: "phase-close",
	description: "Does this phase clear its gates and the grader, or does it get another rework",
	output: phaseCloseSchema,
	run: ({ ctx, logger }) => {
		const clock = ctx.getStepResult<{ retry: number; hash: string }>("close-clock")
		const priorRetries = clock?.retry ?? 0
		const gates = ctx.getStepResult<PhaseGates>("phase-gates")
		const grade = ctx.getStepResult<Record<string, PhaseGrade | undefined>>("grading")?.[GRADE_ARM]
		const failedVerifications = failedVerificationsOf(ctx)

		// THREE ways a phase is refused now, in order of how much they are worth.
		//
		// A failing verification comes first and is new here. kimchi never needed it as a separate check
		// because a failed verification is `fail_step` in its state machine and the step carries a `failed`
		// status forever after; this port turned that into a boolean that `phase-close` did not read, so a
		// phase whose verification exited non-zero could be graded A and shipped. It is also the only one of
		// the three that is not a judgement — the command was re-run at the top of this turn and the exit
		// code is what it is.
		//
		// Then kimchi's own two, in kimchi's order (`phases.ts`): a flagged F gate feeds the retry pipeline
		// FIRST — unlike a step gate, it is not an immediate refusal but it does buy a rework — and only a
		// phase with no block flags reaches the grader at all. Then the grade decides: A/B advance, C/D/F
		// refuse.
		const flagged = hasBlockingFlag(gates?.gates)
		const blocked = flagged || failedVerifications.length > 0
		const refused = blocked || gradeRefuses(grade?.grade, priorRetries)
		const retry = refused ? priorRetries + 1 : priorRetries

		// kimchi's failure-hash short-circuit (`recordBlockHashAndCheckRepeat`): a closing turn that comes
		// back with exactly the refusal it came back with last time means the rework changed nothing, and
		// spending the rest of the budget re-proving that is waste. Only blocking refusals are hashed — a
		// grade is a fresh judgement each time and two C's in a row are not evidence of a stuck loop.
		const failureHash = blocked ? hashFailure(flaggedGatesOf(gates), failedVerifications) : ""
		const repeated = failureHash !== "" && failureHash === clock?.hash

		// Exhausting the budget stops the loop, but WHAT that means depends on why. kimchi splits these and
		// this port did not: a phase that only ever fell short on the grade advances, because "the agent had
		// its retries; we don't block continuation indefinitely" (`phases.ts`). A phase still holding a
		// block flag or a failing command does NOT get to advance as if it had completed — kimchi escalates
		// that one to a human and pauses the ferment, and with no human to escalate to the honest rendering
		// is to let the run continue but record the phase as failed, so the ship check and the journey
		// grader both meet it as a failure instead of a summary.
		const exhausted = retry > MAX_BLOCK_RETRIES
		const accepted = !refused || exhausted || repeated
		const outcome: "completed" | "failed" = accepted && blocked ? "failed" : "completed"

		logger.info("phase closing turn finished", {
			flagged,
			failedVerifications: failedVerifications.length,
			grade: grade?.grade ?? null,
			minimum: minimumAcceptableGrade(priorRetries),
			refused,
			repeated,
			retry,
			accepted,
			outcome,
		})
		return {
			accepted,
			outcome,
			retry,
			grade,
			refused,
			minimum: minimumAcceptableGrade(priorRetries),
			flags: flaggedGatesOf(gates),
			failedVerifications,
			failureHash,
		}
	},
})

/**
 * A stable name for one refusal — kimchi's `hashFlags`, over both kinds of blocking refusal.
 *
 * Deliberately not a real hash: the string IS the identity, it is only ever compared to another one
 * produced the same way, and a readable one shows up in the run log where a digest would not.
 */
const hashFailure = (
	flags: readonly { id: string; rationale: string }[],
	failures: readonly FailedVerification[],
): string =>
	[
		...flags.map((flag) => `gate:${flag.id}:${flag.rationale}`),
		...failures.map((failure) => `verify:${failure.step}:${failure.exitCode}:${failure.command}`),
	]
		.sort()
		.join("|")

/** The F verdicts that blocked, in the shape the rework prompt and `phase-result` read. */
const flaggedGatesOf = (gates: PhaseGates | undefined): { id: string; rationale: string; evidence: string }[] =>
	(gates?.gates ?? [])
		.filter((gate) => normalizeVerdict(gate.verdict) === "flag")
		.map((gate) => ({ id: gate.id, rationale: gate.rationale, evidence: gate.evidence }))

/**
 * How many reworks this phase has already had, read at the TOP of a closing turn.
 *
 * Same reason as `attempt-clock`: `phase-close` cannot count itself, and a loop body's
 * static key drops the iteration index, so its own key is exactly what a bare self-read would hit.
 */
const closeClock = createStep({
	name: "close-clock",
	description: "How many times this phase has been sent back",
	output: Type.Object({ retry: Type.Number(), refused: Type.Boolean(), hash: Type.String() }),
	run: ({ ctx }) => {
		const previous = ctx.getStepResult<PhaseClose>("phase-close")
		// The previous turn's failure identity rides along so this one can tell "the rework fixed nothing"
		// apart from "the rework fixed something and there is more left".
		//
		return {
			retry: previous?.retry ?? 0,
			refused: previous?.refused === true,
			hash: previous?.failureHash ?? "",
		}
	},
})

/** The rework kimchi's planner would dispatch on a refusal: address the grader's recommendations. */
const phaseRework = createAgentStep({
	name: "phase-rework",
	description: "Address the grader's recommendations before the phase is graded again",
	output: workerReportSchema,
	background: true,
	optional: true,
	retry: { maxRetry: 0 },
	maxDurationMs: FERMENT_WORKER_BUDGETS.standard.maxDuration * 1000,
	prompt: ({ ctx }) => {
		const item = ctx.getStepResult<PhaseItem>("phase-ctx")
		const close = ctx.getStepResult<PhaseClose>("phase-close")
		return phaseReworkPrompt({
			plan: planOf(ctx),
			phase: item?.phase ?? { name: "(unknown)", goal: "(unknown)" },
			grade: close?.grade,
			flags: close?.flags ?? [],
			minimum: close?.minimum ?? "A",
			retry: close?.retry ?? 1,
			maxRetries: MAX_BLOCK_RETRIES,
			// Named first in the prompt when present: it is the refusal this rework can actually clear, and
			// the next closing turn re-runs the same commands to decide whether it did.
			failedVerifications: close?.failedVerifications ?? [],
		})
	},
})

const reworkRound = createWorkflow({ name: REWORK_ARM }).then(phaseRework).commit()

/** A rework runs only on a closing turn that follows a refusal — the first pass through has nothing to fix. */
const needsRework = (ctx: RunContext): boolean =>
	ctx.getStepResult<{ refused: boolean }>("close-clock")?.refused === true

/** One row of the phase table the ship check reads. Collected here so the foreach's output is self-describing. */
const phaseResultSchema = Type.Object({
	index: Type.Number(),
	name: Type.String(),
	summary: Type.String(),
	verdicts: Type.String(),
	outcome: Type.String(),
	grade: Type.String(),
	flagged: Type.Boolean(),
	stepsDone: Type.Number(),
	stepsTotal: Type.Number(),
})
type PhaseResult = Static<typeof phaseResultSchema>

const phaseResult = createStep({
	name: "phase-result",
	description: "Summarize the phase for the ship check",
	output: phaseResultSchema,
	run: ({ ctx }) => {
		// `phase-ctx` is the foreach item itself and cannot be absent — if it is, the path below is wrong
		// too, and silently reading phase 1's record would be worse than stopping.
		const item = mustRead<PhaseItem>(ctx, "phase-ctx", "it is the item this phase body was handed")
		// Explicit paths, because this step sits OUTSIDE the closing loop while the gates and the grade sit
		// inside it: a bare read resolves to `phases@N/phase-gates`, which does not exist. Loop iteration
		// indices are dropped from the static key, so `close/…` names the LAST closing turn —
		// the accepted one. `phase-close` is a function step with no failure mode, so its absence is an
		// addressing bug; the gates are an `optional` agent step, so theirs is not.
		const close = mustRead<PhaseClose>(
			ctx,
			`phases@${item.index - 1}/close/phase-close`,
			"every closing turn records one",
		)
		const gates = ctx.getStepResult<PhaseGates>(`phases@${item.index - 1}/close/phase-gates`)
		const steps = settledStepsOf(ctx)
		// A step counts as settled if the attempt loop settled it, OR if it was blocked on its verification
		// and the last closing turn's re-run of that command came back clean. Without the second half, a
		// step the rework actually FIXED would read as unsettled forever — `steps` is frozen before the
		// closing loop starts, so `done` can never become true again no matter what the rework does.
		// `blockedOnVerification` is what keeps the rescue honest: a step that flagged a gate or returned
		// nothing is never re-run, so its absence from the failures says nothing at all about it.
		const stillFailing = new Set(close.failedVerifications.map((failure) => failure.step))
		const settled = steps.filter((step) => step.done || (step.blockedOnVerification && !stillFailing.has(step.index)))
		return {
			index: item.index,
			name: item.phase.name,
			summary: gates?.summary ?? "(no phase summary)",
			verdicts: (gates?.gates ?? []).map((gate) => `${gate.id}:${gate.verdict}`).join(" ") || "(none)",
			outcome: close.outcome,
			grade: close.grade?.grade ?? "(ungraded — the grader returned nothing)",
			flagged: close.flags.length > 0,
			stepsDone: settled.length,
			stepsTotal: steps.length,
		}
	},
})

/**
 * The phase's closing turn, and it can repeat: gates → grade → decide, with a rework in front of every
 * attempt after the first. This is kimchi's `complete_ferment_phase` loop — a refused grade sends the
 * agent back with the grader's recommendations and the phase is completed again, up to
 * `MAX_BLOCK_RETRIES` times.
 */
const gradeRound = createWorkflow({ name: GRADE_ARM }).then(phaseGrade).commit()

/**
 * kimchi grades a phase only once its gates are clean: "Step 4: no block flags from gates or project
 * checks. Run the per-phase LLM grader." A flagged phase goes straight to the retry pipeline, so the
 * grader spawn is never bought for work already known to be blocked.
 */
const gradeable = (ctx: RunContext): boolean => !hasBlockingFlag(ctx.getStepResult<PhaseGates>("phase-gates")?.gates)

const phaseClosing = createWorkflow({ name: "closing" })
	.then(closeClock)
	.branch([[needsRework, reworkRound]], { name: "rework" })
	// After the rework and before anything that judges it: the gates, the grader and the close decision all
	// read the same re-run exit codes, taken once per closing turn.
	.then(phaseReverify)
	.then(phaseDiff)
	.then(phaseGates)
	.branch([[gradeable, gradeRound]], { name: "grading" })
	.then(phaseClose)
	.commit()

const phaseBody = createWorkflow({ name: "phase" })
	.then(phaseCtx)
	.then(phaseStartRef)
	.branch([[needsRefine, refineRound]], { name: "refine" })
	.foreach(stepBody, stepSelector, { name: "steps" })
	.dountil(phaseClosing, (_ctx, last) => (last as PhaseClose).accepted, {
		name: "close",
		maxIterations: MAX_BLOCK_RETRIES + 2,
	})
	.then(phaseResult)
	.commit()

const phaseSelector = (ctx: RunContext): readonly PhaseItem[] => {
	const phases = planOf(ctx)?.phases ?? []
	return phases.map((phase, index) => ({ index: index + 1, total: phases.length, phase }))
}

// -- Ship -------------------------------------------------------------------------------------------

const ship = createAgentStep({
	name: "ship",
	description: "Walk the P3 checklist and answer the ferment-scope gates",
	output: shipGatesSchema,
	background: true,
	optional: true,
	retry: { maxRetry: 0 },
	// kimchi's `complete_ferment`, the last of the orchestrator's four turns. C1 walks "the P3 checklist
	// declared at scope time" and C3 reads "every S2 and F1 verdict across the ferment". The verdicts are
	// passed via `ctx.getStepResult` (not session memory), so this step does not need to share a session
	// with `plan` or `step-turn`. It DOES share with `phase-gates` via `ORCHESTRATOR_SESSION` — both are
	// lightweight and benefit from seeing each other's context.
	resumable: ORCHESTRATOR_SESSION,
	prompt: ({ ctx }) => {
		const phases = (ctx.getStepResult<(PhaseResult | undefined)[]>("phases") ?? []).filter(
			(phase): phase is PhaseResult => phase !== undefined,
		)
		return shipPrompt({ intent: intentOf(ctx), plan: planOf(ctx), phases })
	},
})

const phaseTrailOf = (ctx: RunContext): PhaseResult[] =>
	(ctx.getStepResult<(PhaseResult | undefined)[]>("phases") ?? []).filter(
		(phase): phase is PhaseResult => phase !== undefined,
	)

/** The whole run's diff, for the journey grader — kimchi's `gatherPhaseEvidence(ferment.worktree.commit)`. */
const runStartRef = createStep({
	name: "run-start-ref",
	description: "The commit the whole run starts from",
	output: Type.Object({ ref: Type.String() }),
	optional: true,
	run: async ({ abortSignal }) => ({ ref: await currentGitRef(abortSignal) }),
})

const runDiff = createStep({
	name: "run-diff",
	description: "Everything this ferment changed, for the journey grader",
	output: Type.Object({
		available: Type.Boolean(),
		filesChanged: Type.String(),
		diffSnippet: Type.String(),
		elidedBytes: Type.Number(),
	}),
	optional: true,
	run: async ({ ctx, abortSignal }) =>
		phaseDiffSince(ctx.getStepResult<{ ref: string }>("run-start-ref")?.ref ?? "", abortSignal),
})

/**
 * kimchi's `judgeJourneyGradeViaSubagent` — the third grader, and the one this port was missing entirely.
 *
 * It runs after the C gates, over the whole run: the per-phase outcome trail, the ship verdicts and the
 * total diff. In kimchi a C/D/F from it refuses ship and routes through the same retry budget the phase
 * grader uses (`lifecycle.ts`), which is what the loop below reproduces.
 *
 * Why a per-phase grader cannot stand in for it: a phase grader only ever sees its own phase, so nothing
 * in a per-phase pass can notice that phase 1 closed failed and phases 2 and 3 built on top of it. This
 * is also the only reader positioned to see the whole `PhaseResult` trail at once, which is why fixing
 * what {@link shipPrompt} was silently dropping and adding this grader are the same repair.
 *
 * `optional`, and `gradeRefuses(undefined)` reads a missing grade as no refusal, for the reason kimchi
 * gives at every one of its judges: "judge outages must not block the user."
 */
const journeyGrade = createAgentStep({
	name: "journey-grade",
	description: "Grade the whole ferment A-F against what the machine actually shows",
	output: phaseGradeSchema,
	background: true,
	optional: true,
	retry: { maxRetry: 0 },
	prompt: ({ ctx }) => {
		const gates = ctx.getStepResult<Static<typeof shipGatesSchema>>("ship")
		const diff = ctx.getStepResult<DiffEvidence>("run-diff")
		return journeyGraderPrompt({
			intent: intentOf(ctx),
			plan: planOf(ctx),
			phases: phaseTrailOf(ctx),
			shipVerdicts: gates?.gates ?? [],
			diff: diff ?? { available: false, filesChanged: "", diffSnippet: "", elidedBytes: 0 },
			cwd: process.cwd(),
		})
	},
})

type ShipClose = {
	shipped: boolean
	gatesFlagged: boolean
	gradeRefused: boolean
	minimum: string
	grade: PhaseGrade | undefined
}

const shipCloseSchema = Type.Object({
	shipped: Type.Boolean(),
	gatesFlagged: Type.Boolean(),
	gradeRefused: Type.Boolean(),
	minimum: Type.String(),
	grade: Type.Optional(phaseGradeSchema),
})

/**
 * Ship or not, decided once — and deliberately NOT a loop, which is where this departs from kimchi.
 *
 * kimchi's `complete_ferment` returns a tool error on a C/D/F and the planner calls it again, bounded by
 * `MAX_BLOCK_RETRIES` (`lifecycle.ts`). The phase-level equivalent of that loop is worth its cost because
 * a phase rework has something to bite on: a named failing command, re-run by the next closing turn to
 * decide whether the rework worked. A ferment-level rework has none of that — no phase, no step, no
 * command, just "fix the work somewhere across the run" — and each round costs another `ship` turn and
 * another grader spawn. The retries were buying agitation, not evidence, so they are gone and the whole
 * closing turn is one step.
 *
 * What that changes: the bar. kimchi requires an A on the first attempt and settles for a B once the run
 * has been reworked (`minimumAcceptableGrade`), and the journey grader is told to be pessimistic —
 * "Most work is B or C, not A". With no reworks there is no first attempt to be strict about, so the bar
 * is the reworked one, B. Grading a single-shot run against A would refuse nearly every run that ever
 * ships and make the signal useless.
 */
const shipClose = createStep({
	name: "ship-close",
	description: "Does the ferment clear its gates and the journey grader",
	output: shipCloseSchema,
	run: ({ ctx, logger }) => {
		const gates = ctx.getStepResult<Static<typeof shipGatesSchema>>("ship")
		const grade = ctx.getStepResult<PhaseGrade>("journey-grade")

		// kimchi's order at `complete_ferment`: the C gates decide ship or refuse, and the journey grade
		// ENFORCES quality on top — "a C/D/F grade refuses ship". A grader that never answered does not
		// refuse anything (`gradeRefuses` reads `undefined` as no refusal), for the reason kimchi gives at
		// every one of its judges: "judge outages must not block the user."
		const gatesFlagged = gates === undefined || hasBlockingFlag(gates.gates)
		// `1` rather than `0`: the bar is B, per the note above.
		const minimum = minimumAcceptableGrade(1)
		const gradeRefused = gradeRefuses(grade?.grade, 1)
		const shipped = !gatesFlagged && !gradeRefused

		logger.info("ship closing turn finished", {
			gatesFlagged,
			grade: grade?.grade ?? null,
			minimum,
			gradeRefused,
			shipped,
		})
		return { shipped, gatesFlagged, gradeRefused, minimum, grade }
	},
})

const report = createStep({
	name: "report",
	description: "Summarize the run for the log",
	output: Type.Object({
		shipped: Type.Boolean(),
		grade: Type.String(),
		phases: Type.Number(),
		phasesFailed: Type.Number(),
		steps: Type.Number(),
		stepsDone: Type.Number(),
	}),
	run: ({ ctx }) => {
		const phases = phaseTrailOf(ctx)
		const close = ctx.getStepResult<ShipClose>("ship-close")
		return {
			// Shipped means what `complete_ferment` means: the C gates were voted, none of them flagged, and
			// the journey grader either cleared the run or ran out of retries to refuse it with.
			shipped: close?.shipped === true,
			grade: close?.grade?.grade ?? "(ungraded — the journey grader returned nothing)",
			phases: phases.length,
			// Carried out of the run rather than left in the log: a phase that closed failed is the single
			// most useful thing to correlate a scored_fail against, and nothing above this line reports it.
			phasesFailed: phases.filter((phase) => phase.outcome === "failed").length,
			steps: phases.reduce((total, phase) => total + phase.stepsTotal, 0),
			stepsDone: phases.reduce((total, phase) => total + phase.stepsDone, 0),
		}
	},
})

export default createWorkflow({
	name: "ferment-oneshot",
	description:
		"Run a terminal-bench task as kimchi's one-shot ferment: scope it into phases and steps, do each step and answer for it, gate every completion",
	input: taskInputSchema,
	// Deliberately no `defaultModel` here. Per-step model resolution is step `model` → workflow
	// `defaultModel` → the harness/session default; no step in this workflow
	// declares its own `model` either, so leaving `defaultModel` unset makes every step fall through to
	// whatever `--model` the harbor adapter launched kimchi with. A hardcoded default here would silently
	// override the benchmark's model selection for every run that does not happen to match it — which is
	// exactly the failure mode this workflow exists to be compared honestly against `tb-solver` without.
})
	// Scoping repeats while the planner is still asking, exactly as kimchi's interview does: ask, hear the
	// judge, replan. No round cap — the loop's `maxIterations` default is a runaway guard the builder
	// requires, and the run's own deadline is what actually ends a planner that never converges.
	// Taken before anything runs, so the journey grader can be shown the whole ferment's diff rather than
	// the last phase's — kimchi reads the same thing off `ferment.worktree.commit`.
	.then(runStartRef)
	.dountil(scopeRound, (_ctx, last) => (last as ScopeCheck).ready, { name: "scoping" })
	// Phases run in the order the plan gives them, one at a time. Sequential is not a simplification here:
	// concurrent items must have non-overlapping side effects, which two agents editing
	// the same container cannot promise.
	.foreach(phaseBody, phaseSelector, { name: "phases" })
	// The C gates, then the journey grade over the whole trail, then one decision. No loop — see
	// `ship-close` for why the ferment-level retries kimchi has are not worth their cost here.
	.then(runDiff)
	.then(ship)
	.then(journeyGrade)
	.then(shipClose)
	.then(report)
	.commit()
