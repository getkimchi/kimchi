/**
 * deep-solve: a staged terminal-bench solver workflow.
 *
 * Design sources:
 *  - LangChain deep-agents playbook: planning artifact, subagents with isolated
 *    context, state offloaded from conversation, verification before stopping.
 *  - LangChain "harness engineering" (52.8 -> 66.5 on TB 2.0): verification must
 *    mean RUNNING things; map the environment once; every prompt quotes its budget.
 *  - TB failure taxonomy (ICLR 2026): 47-60% of frontier failures are
 *    Verification-class — so a dedicated fresh-context stage per round.
 *
 * Shape: plan -> (clock -> execute -> check -> audit? -> checkpoint)* -> report
 *
 *  - `plan` maps the environment and decomposes the task into TODOS with
 *    `doneWhen` shell probes.
 *  - `execute` works the todo list in a resumable session. No output schema —
 *    the product is the machine, not a self-report.
 *  - `check` is a fresh subagent that re-runs every probe. The run stops early
 *    only on `check`'s verdict.
 *  - `audit` is a second opinion on a "complete" verdict, decorrelated by method
 *    (never sees the todo list). Bought only while a repair round still fits.
 *  - `checkpoint` fingerprints failures each round; raises `stuck` when two
 *    consecutive rounds fail identically, switching execute to "change strategy".
 *
 * Every agent step is `background: true` (isolated pi subprocess, no conversation
 * in the orchestrator).
 *
 * Requires `deadlineIso` in the run input and `TB_AGENT_TIMEOUT_SEC` in the env —
 * supplied only by PiWorkflowAgent. WorkflowAgent (kimchi) sends `{instruction}`
 * alone, so running this under `agent=kimchi-workflow` fails input validation
 * visibly rather than silently on a fabricated clock.
 */
import { type Static, Type } from "typebox"
import { createAgentStep, createStep, createWorkflow, type RunContext } from "@kimchi-dev/kimchi-workflows"

// ---------------------------------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------------------------------

export const inputSchema = Type.Object({
	/** The verbatim terminal-bench instruction. */
	instruction: Type.String(),
	/** When the harness kills the agent phase — ISO 8601. */
	deadlineIso: Type.String(),
})

const todoSchema = Type.Object({
	id: Type.String({ description: "Short stable id: t1, t2, ..." }),
	title: Type.String({ description: "One concrete outcome, not an activity." }),
	doneWhen: Type.String({
		description: "ONE non-interactive shell command that probes whether this outcome holds.",
	}),
	expect: Type.String({ description: "What the probe's output/exit status must show when the todo is done." }),
})

export const planSchema = Type.Object({
	environmentMap: Type.String({
		description:
			"Compact map of this machine for later stages: working dir, task-relevant files/dirs, languages, tools and versions, running services. Facts only.",
	}),
	todos: Type.Array(todoSchema, { description: "The task decomposed into checkable outcomes, ordered by importance." }),
	risks: Type.Array(Type.String(), {
		description: "Ambiguities in the task and the reading you chose. Empty if genuinely none.",
	}),
})

const todoStatus = Type.Union([Type.Literal("done"), Type.Literal("not_done"), Type.Literal("unknown")])

export const checkSchema = Type.Object({
	// Ordered before the verdict on purpose: a checker that first writes down what it could not
	// examine is far less likely to then declare the task complete anyway.
	unchecked: Type.Array(Type.String(), {
		description: "Everything the task requires that you did NOT actually probe. Empty only if you covered it all.",
	}),
	todoResults: Type.Array(
		Type.Object({
			id: Type.String(),
			status: todoStatus,
			evidence: Type.String({ description: "The real command output/exit status you observed. Paste, don't summarise." }),
		}),
	),
	gaps: Type.Array(
		Type.Object({
			what: Type.String({ description: "What is wrong or missing, concretely." }),
			evidence: Type.String({ description: "Command + output that demonstrates it." }),
			suggestedFix: Type.String(),
		}),
		{ description: "Empty when nothing is wrong." },
	),
	taskComplete: Type.Boolean({
		description: "True ONLY if you probed every requirement of the task yourself and saw it hold.",
	}),
})

/**
 * The audit's reply. Shares the gap shape with `check` so a dissent feeds the next round's execute
 * the same way, but carries no todo statuses — the audit never sees the todo list.
 */
export const auditSchema = Type.Object({
	unchecked: Type.Array(Type.String(), {
		description: "What you did not get to. Honest bookkeeping; here it does NOT decide the verdict.",
	}),
	gaps: Type.Array(
		Type.Object({
			what: Type.String({ description: "What is wrong or missing, concretely." }),
			evidence: Type.String({ description: "Command + output that demonstrates it." }),
			suggestedFix: Type.String(),
		}),
	),
	taskComplete: Type.Boolean({
		description: "False ONLY on demonstrated failure you observed and pasted as evidence. Doubt is not a dissent.",
	}),
})

type Plan = Static<typeof planSchema>
type Check = Static<typeof checkSchema>
type Audit = Static<typeof auditSchema>

// ---------------------------------------------------------------------------------------------------
// Time budget. Agents are bad at time estimation, so the engine enforces boxes and every prompt
// quotes its own. Percentages have floors/ceilings; execute takes a share of what REMAINS, so rounds
// shrink toward the deadline instead of colliding with it, and the last round takes the tail whole.
// ---------------------------------------------------------------------------------------------------

const BUDGET_SEC = Math.max(60, Number(process.env.TB_AGENT_TIMEOUT_SEC ?? 900))
const clampSec = (sec: number, lo: number, hi: number) => Math.round(Math.min(Math.max(sec, lo), hi)) * 1000

/** Settle slack so the final step lands instead of being cut off mid-write. */
const MARGIN_MS = 45_000
/** Environment mapping + decomposition; roughly constant work, so a near-constant cap. */
const PLAN_CAP_MS = clampSec(BUDGET_SEC * 0.2, 90, 210)
/** Paid once per round; a fresh checker re-running probes plus an audit pass. */
const CHECK_CAP_MS = clampSec(BUDGET_SEC * 0.15, 90, 210)
/** Below this a round cannot land a single meaningful edit. */
const EXECUTE_FLOOR_MS = 120_000
const EXECUTE_SHARE_OF_REMAINING = 0.6
/** Runaway guard only — the clock in `checkpoint` is the real exit. */
const MAX_ROUNDS = 12
/** Second opinion on a "complete" verdict. It re-derives its own checks, so it needs more room than `check`. */
const AUDIT_CAP_MS = clampSec(BUDGET_SEC * 0.2, 150, 300)

/**
 * A second opinion is worth buying only when a DISAGREEMENT is still actionable: the audit itself,
 * plus the smallest repair round, plus its check, plus settle slack must all fit. Below that the
 * audit can only confirm or deliver news nobody can act on. A wrong "complete" is the expensive
 * error — the run stops holding exactly the budget that would have fixed the task — while a wrong
 * "not complete" merely spends a round the schedule already had.
 */
const auditAffordable = (remainingSec: number): boolean =>
	remainingSec * 1000 >= AUDIT_CAP_MS + EXECUTE_FLOOR_MS + CHECK_CAP_MS + MARGIN_MS

const executeBoxMs = (remainingSec: number): number => {
	const remainingMs = remainingSec * 1000
	const spendableMs = remainingMs - CHECK_CAP_MS - MARGIN_MS
	const shareMs = remainingMs * EXECUTE_SHARE_OF_REMAINING
	// Holding time back only pays if a further round could use it; otherwise take the tail whole.
	const anotherRoundFits = spendableMs - shareMs >= EXECUTE_FLOOR_MS + CHECK_CAP_MS
	return Math.max(EXECUTE_FLOOR_MS, Math.round(anotherRoundFits ? Math.min(shareMs, spendableMs) : spendableMs))
}

const remainingSecNow = (ctx: RunContext): number => {
	const task = ctx.getInitData<{ deadlineIso: string }>()
	return (new Date(task?.deadlineIso ?? Date.now()).getTime() - Date.now()) / 1000
}

/** Soft deadline quoted to the agent, below the enforced cutoff, so ordinary overshoot still lands. */
const timeNote = (boxMs: number, remainingSec: number): string => {
	const softSec = Math.max(30, Math.round((boxMs / 1000) * 0.8))
	return [
		`CLOCK: aim to finish THIS step in about ${softSec}s; shortly after that you are cut off and`,
		"anything not yet written down is lost. At ~80% of that budget, stop investigating and deliver",
		"the best result you have — delivered beats perfect-but-late, every time.",
		`(~${Math.max(0, Math.round(remainingSec))}s remain before this machine is graded.)`,
	].join("\n")
}

/** How this benchmark grades, in every prompt that acts or judges. */
const GRADING = [
	"GRADING: hidden automated tests inspect the FINAL STATE of this machine after you exit. Only real,",
	"working behaviour scores. Never hunt for test files, never hardcode an expected answer — a stub",
	"that fakes the output scores zero. Everything must survive your shell exiting: write files to",
	"disk, install things properly, leave services actually running. Exact paths, filenames, formats",
	"and values from the task statement are usually exactly what gets checked.",
].join("\n")

const todoTable = (todos: readonly Static<typeof todoSchema>[], results?: Check["todoResults"]): string => {
	const statusOf = (id: string) => results?.find((r) => r.id === id)?.status ?? "not_done"
	return todos
		.map((t) => `  [${t.id}] (${statusOf(t.id)}) ${t.title}\n        probe:  ${t.doneWhen}\n        expect: ${t.expect}`)
		.join("\n")
}

// ---------------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------------

const plan = createAgentStep({
	name: "plan",
	description: "Map the environment and decompose the task into probe-checkable todos",
	output: planSchema,
	background: true,
	maxDurationMs: PLAN_CAP_MS,
	// A lost plan degrades the run but must not end it: later steps fall back to the task statement.
	optional: true,
	retry: { maxRetry: 0 },
	prompt: ({ ctx }) => {
		const task = ctx.getInitData<{ instruction: string }>()
		return [
			"You are the PLANNING stage of a staged agent. Later stages see only the task and what you",
			"write here — they waste their budget rediscovering anything you leave out.",
			"",
			"TASK:",
			task?.instruction ?? "(missing)",
			"",
			"THIS STAGE IS READ-ONLY. Inspect freely (ls, cat, find, git log/status, ps, which, --version)",
			"but change nothing: no writes, no installs, no fixes. A later stage does the work; work done",
			"here escapes verification.",
			"",
			GRADING,
			"",
			timeNote(PLAN_CAP_MS, remainingSecNow(ctx)),
			"",
			"First, MAP THE ENVIRONMENT — a few quick commands, not an audit. Record in `environmentMap`",
			"what a colleague would need to start working immediately: where the relevant files are, what",
			"languages/tools/services are present and their versions, anything surprising.",
			"",
			"Then DECOMPOSE the task into `todos`. Go through the task statement sentence by sentence and",
			"capture every distinct requirement — each path, filename, format, exact value, count and",
			"behaviour it names. Each todo is an OUTCOME with:",
			"  - `doneWhen`: one non-interactive shell command probing whether the outcome holds on this",
			"    machine (probe real behaviour — run the thing — not mere file existence, unless existence",
			"    is truly all that is asked);",
			"  - `expect`: what that command must show. Make probes able to FAIL on wrong-but-plausible",
			"    states: count exhaustively, compare whole outputs, assert the absence of extras.",
			"For requirements with a numeric or exact answer (a metric, a hash, a count, a rendered output),",
			"the probe must compare against a value derived INDEPENDENTLY of the implementation — from the",
			"task's own data, a reference tool, or a hand derivation. 'The program prints a number' is not a",
			"probe; correct-looking output from a wrong algorithm is the main way this benchmark is lost.",
			"Order todos by importance; keep them to the handful that decide the outcome.",
			"",
			"Finally list `risks`: where the task is ambiguous and which reading you chose.",
		].join("\n")
	},
})

/** Wall clock + doom-loop memory at the top of each round. */
const clock = createStep({
	name: "clock",
	description: "Time remaining, round number, and the previous round's failure fingerprint",
	output: Type.Object({ remainingSec: Type.Number(), round: Type.Number(), lastGapsKey: Type.String() }),
	run: ({ ctx }) => {
		const previous = ctx.getStepResult<{ round: number; gapsKey: string }>("solve/checkpoint")
		return {
			remainingSec: remainingSecNow(ctx),
			round: (previous?.round ?? 0) + 1,
			lastGapsKey: previous?.gapsKey ?? "",
		}
	},
})

const execute = createAgentStep({
	name: "execute",
	description: "Work the todo list",
	// Deliberately no output schema: the product is the machine, and `check` reads the machine.
	// A required self-report would only add a way to fail work that already landed.
	background: true,
	maxDurationMs: ({ ctx }) => executeBoxMs(ctx.getStepResult<{ remainingSec: number }>("clock")?.remainingSec ?? 0),
	// Hitting the box costs the round, not the run: edits stay on disk and `check` still judges them.
	optional: true,
	retry: { maxRetry: 0 },
	// The one session that continues across rounds, so progress is sustained rather than re-derived.
	resumable: true,
	prompt: ({ ctx }) => {
		const task = ctx.getInitData<{ instruction: string }>()
		const design = ctx.getStepResult<Plan>("plan")
		const round = ctx.getStepResult<{ remainingSec: number; round: number }>("clock")
		const verdict = ctx.getStepResult<Check>("check")
		// When the audit is why this round exists, its findings are the ONLY description of what is
		// wrong — the first checker said the task was done. Merge both lists, dedup by description.
		const audited = auditVerdict(ctx)
		const gaps = [...(verdict?.gaps ?? []), ...(audited?.gaps ?? [])].filter(
			(g, i, all) => all.findIndex((o) => o.what === g.what) === i,
		)
		const previous = ctx.getStepResult<{ stuck: boolean }>("checkpoint")
		const remainingSec = round?.remainingSec ?? 0
		const boxMs = executeBoxMs(remainingSec)

		const continuing =
			(round?.round ?? 1) > 1
				? [
						"",
						"YOU HAVE BEEN HERE BEFORE — the conversation above is your own from the previous round.",
						"Continue it; re-read any file before editing it again.",
					].join("\n")
				: ""

		const gapsBlock =
			gaps.length > 0
				? [
						"",
						"AN INDEPENDENT CHECK FOUND PROBLEMS. Fix the causes, do not paper over them:",
						...gaps.map((g) => `  - ${g.what}\n    evidence: ${g.evidence}\n    suggestion: ${g.suggestedFix}`),
					].join("\n")
				: ""

		const stuckBlock = previous?.stuck
			? [
					"",
					"STOP: THE LAST TWO ROUNDS FAILED IDENTICALLY. Whatever you have been trying is not working.",
					"Do not repeat it. Re-diagnose from scratch: question your assumptions, read the actual error",
					"output again, and take a different approach this round.",
				].join("\n")
			: ""

		return [
			"Complete this task on the machine you are on.",
			"",
			"TASK:",
			task?.instruction ?? "(missing)",
			"",
			design?.environmentMap ? `ENVIRONMENT (mapped earlier — trust but verify):\n${design.environmentMap}` : "",
			"",
			"TODO LIST — a floor, not a ceiling. If it contradicts the task statement, the task wins:",
			(design?.todos?.length ?? 0) > 0
				? todoTable(design?.todos ?? [], verdict?.todoResults)
				: "  (no plan was produced — satisfy the task statement above, in full)",
			continuing,
			gapsBlock,
			stuckBlock,
			"",
			GRADING,
			"",
			timeNote(boxMs, remainingSec),
			"",
			"Work the not_done todos most-important-first, and leave the machine working even if you cannot",
			"finish everything: a partial result that runs beats a half-applied edit that does not.",
			"",
			"VERIFY BY RUNNING, NOT BY RE-READING. The single most common way agents fail this benchmark is",
			"writing something, re-reading their own work, deciding it looks right, and stopping. After each",
			"todo, RUN its probe command and look at the real output; re-read the task statement once more",
			"for exact paths, names, formats and values; make the result contain exactly what is asked and",
			"nothing extra. Where the task wants a numeric or exact result, test yours against an",
			"independently derived value (reference tool, small hand-checked case, known invariant) — an",
			"algorithm that runs and produces plausible numbers is not yet an algorithm that is right.",
			"Delete scratch files you created that the task did not ask for.",
		].join("\n")
	},
})

const check = createAgentStep({
	name: "check",
	description: "Fresh-context verification: re-run every probe, then audit beyond the todo list",
	output: checkSchema,
	background: true,
	maxDurationMs: CHECK_CAP_MS,
	// A checker that dies at its box has said nothing; `checkpoint` reads silence as "not complete".
	optional: true,
	retry: { maxRetry: 0 },
	// Never resumable: its entire value is fresh eyes.
	prompt: ({ ctx }) => {
		const task = ctx.getInitData<{ instruction: string }>()
		const design = ctx.getStepResult<Plan>("plan")
		const round = ctx.getStepResult<{ remainingSec: number }>("clock")
		return [
			"You are auditing a machine someone else just worked on. Trust nothing they may have believed:",
			"most failures on this benchmark are verification failures — work declared done that a shallow",
			"check waved through, or was never checked at all. Your job is to be the check that was missing.",
			"",
			"THE TASK THEY WERE GIVEN:",
			task?.instruction ?? "(missing)",
			"",
			"TODO LIST WITH PROBES (written before the work was attempted; often incomplete):",
			(design?.todos?.length ?? 0) > 0
				? todoTable(design?.todos ?? [])
				: "  (none — judge the task statement on its own terms, end to end)",
			(design?.risks?.length ?? 0) > 0
				? ["", "THE PLANNER WAS UNSURE ABOUT THESE — probe them hardest:", ...(design?.risks ?? []).map((r) => `  - ${r}`)].join("\n")
				: "",
			"",
			timeNote(CHECK_CAP_MS, round?.remainingSec ?? 0),
			"",
			"Method:",
			"  - run EVERY probe from a clean shell (`bash -lc '<probe>'`, starting from /), never from",
			"    state you set up — the machine is graded after everyone has left, so anything depending on",
			"    an exported variable, a cwd or an activated venv is already broken;",
			"  - record the REAL output as `evidence`; never mark a todo done because it should be done;",
			"  - then go BEYOND the list: re-read the task requirement by requirement (paths, names, formats,",
			"    exact values, counts) and probe what the todos do not cover — this is where outcomes are",
			"    usually decided; run the deliverable end to end the way the task describes using it;",
			"  - look for what should NOT be there: stray files, extra rows, debug output, leftovers;",
			"  - for numeric or exact-output requirements, do not accept output that merely looks right:",
			"    verify at least one case against an independently derived value (recompute with a different",
			"    tool or by hand on a small input). Plausible-but-wrong numbers pass shallow checks and fail",
			"    the graders;",
			"  - if a probe command is itself broken, judge the outcome by other means and say so;",
			"  - DO NOT FIX ANYTHING. Report only — the next round repairs what you find.",
			"",
			"KEEP THE LAST QUARTER OF YOUR BUDGET FOR THE VERDICT and stop probing when you reach it: a",
			"verdict that never arrives is read as NOT COMPLETE and everything you found is lost.",
			"",
			"Write `unchecked` BEFORE deciding `taskComplete`, and let it decide: if anything required is",
			"listed there, `taskComplete` is false. Set it true only if you personally probed every",
			"requirement and saw it hold. When in doubt, say not complete — that costs one more round;",
			"a wrong 'complete' ends the run with the task broken and the clock unspent.",
		].join("\n")
	},
})

/** The audit arm lives behind a branch; its output key is rewritten every round, so "did the audit
 * run THIS round" stays answerable (the step's own key would keep the last dissent forever). */
const AUDIT_ARM = "audit-round"

const auditVerdict = (ctx: RunContext): Audit | undefined =>
	ctx.getStepResult<Record<string, Audit | undefined>>("second-opinion")?.[AUDIT_ARM]

const audit = createAgentStep({
	name: "audit",
	description: "Second, decorrelated opinion on a 'complete' verdict",
	output: auditSchema,
	background: true,
	maxDurationMs: AUDIT_CAP_MS,
	// Silence must read as NO OBJECTION: the first check already said complete, and an audit that died
	// at its box has said nothing. Reading silence as dissent would let a timeout spin the loop forever.
	optional: true,
	retry: { maxRetry: 0 },
	// Never resumable — its entire value is a reader with no history on this machine.
	prompt: ({ ctx }) => {
		const task = ctx.getInitData<{ instruction: string }>()
		const round = ctx.getStepResult<{ remainingSec: number }>("clock")
		return [
			"ANOTHER CHECKER ALREADY WENT OVER THIS MACHINE AND DECLARED THE TASK COMPLETE. You are the",
			"second opinion — the last thing between that verdict and the run stopping for good. Your job is",
			"to find what the first checker missed.",
			"",
			"THE TASK:",
			task?.instruction ?? "(missing)",
			"",
			"You are deliberately NOT given their checklist. They confirmed what their list told them to look",
			"for; a second pass by the same method finds the same things. You work from the task statement,",
			"end to end, the way someone actually using the result would.",
			"",
			timeNote(AUDIT_CAP_MS, round?.remainingSec ?? 0),
			"",
			"Where checklist-driven passes are habitually thin, in order of payoff:",
			"  - RUN the deliverable the whole way through as the task describes and read what comes out;",
			"  - for numeric or exact-output requirements, RECOMPUTE the expected value independently (a",
			"    different tool, a hand calculation, a reference implementation) and compare exactly —",
			"    plausible-looking numbers are how completed-looking tasks score zero;",
			"  - everything from a clean shell (`bash -lc '<cmd>'`, from /) — no exported vars, no venv, no cwd;",
			"  - exact formats, values, counts, ordering against the task's own words, not what is reasonable;",
			"  - what should NOT be there: stray files, extra rows, debug output, leftovers;",
			"  - the edge inputs the task admits: empty, missing, malformed, duplicate, largest, smallest.",
			"",
			"DO NOT FIX ANYTHING and do not improve anything. Report only — a repair round follows if you are",
			"right; if you start editing, nobody ever checks what you did.",
			"",
			"KEEP THE LAST QUARTER OF YOUR BUDGET FOR THE VERDICT. A reply that never arrives is read as NO",
			"OBJECTION and the run stops on the first verdict — a defect you found but did not report is a",
			"task lost outright.",
			"",
			"THE BAR FOR OVERTURNING IS EVIDENCE, NOT SUSPICION. Say `taskComplete: false` ONLY with a",
			"concrete failure you observed — paste the command and output in `evidence`. A corner you did not",
			"reach or something you would have built differently is not a dissent: reopening spends a repair",
			"round that can break work which is currently correct. Nothing demonstrable = `taskComplete: true`.",
		].join("\n")
	},
})

const auditRound = createWorkflow({ name: AUDIT_ARM }).then(audit).commit()

/** Buy the second opinion only on a round about to stop successfully, and only while actionable. */
const wantsAudit = (ctx: RunContext): boolean =>
	ctx.getStepResult<Check>("check")?.taskComplete === true && auditAffordable(remainingSecNow(ctx))

/** Deterministic middleware: stop rule, and the doom-loop detector feeding `execute`'s stuck block. */
const checkpoint = createStep({
	name: "checkpoint",
	description: "Decide whether another round is affordable; detect repeated identical failures",
	output: Type.Object({
		taskComplete: Type.Boolean(),
		mustStop: Type.Boolean(),
		stuck: Type.Boolean(),
		gapsKey: Type.String(),
		remainingSec: Type.Number(),
		round: Type.Number(),
	}),
	run: ({ ctx, logger }) => {
		const verdict = ctx.getStepResult<Check>("check")
		const audited = auditVerdict(ctx)
		const opened = ctx.getStepResult<{ round: number; lastGapsKey: string }>("clock")
		const remainingSec = remainingSecNow(ctx)
		const round = opened?.round ?? 0

		// Missing check verdict reads as "not complete": spend another round rather than declare victory
		// blind. The audit reads the OPPOSITE way — silence is no objection — so the round passes only
		// when the check said complete AND the second opinion did not demonstrably overturn it.
		const taskComplete = verdict?.taskComplete === true && audited?.taskComplete !== false

		// Failure fingerprint: unresolved todo ids + gap descriptions (both checkers'). Two identical
		// consecutive fingerprints mean the strategy is not working, whatever the transcript says.
		const gapsKey = JSON.stringify([
			(verdict?.todoResults ?? []).filter((r) => r.status !== "done").map((r) => `${r.id}:${r.status}`),
			[...(verdict?.gaps ?? []), ...(audited?.gaps ?? [])].map((g) => g.what).sort(),
		])
		const failedSomething =
			(verdict?.gaps?.length ?? 0) > 0 ||
			(audited?.gaps?.length ?? 0) > 0 ||
			(verdict?.todoResults ?? []).some((r) => r.status !== "done")
		const stuck = !taskComplete && failedSomething && gapsKey === (opened?.lastGapsKey ?? "__none__")

		// Stop when the next round's floor no longer fits in what remains after checking and settling.
		const mustStop =
			remainingSec * 1000 - CHECK_CAP_MS - MARGIN_MS < EXECUTE_FLOOR_MS || round >= MAX_ROUNDS
		logger.info("round finished", {
			round,
			taskComplete,
			audited: audited?.taskComplete ?? null,
			stuck,
			remainingSec: Math.round(remainingSec),
			mustStop,
		})
		return { taskComplete, mustStop, stuck, gapsKey, remainingSec, round }
	},
})

const report = createStep({
	name: "report",
	description: "Summarize the run for the log",
	output: Type.Object({ taskComplete: Type.Boolean(), rounds: Type.Number(), remainingSec: Type.Number() }),
	run: ({ ctx }) => {
		const final = ctx.getStepResult<{ taskComplete: boolean; round: number; remainingSec: number }>("solve/checkpoint")
		return {
			taskComplete: final?.taskComplete === true,
			rounds: final?.round ?? 0,
			remainingSec: Math.round(final?.remainingSec ?? 0),
		}
	},
})

// ---------------------------------------------------------------------------------------------------

const solveRound = createWorkflow({ name: "solve-round" })
	.then(clock)
	.then(execute)
	.then(check)
	// The only place the run may stop early, so the only place worth a whole extra subagent. Skipped
	// on every round a failing check already sends around again — that is what keeps it affordable.
	.branch([[wantsAudit, auditRound]], { name: "second-opinion" })
	.then(checkpoint)
	.commit()

export default createWorkflow({
	name: "deep-solve",
	description:
		"Solve a terminal-bench task: map + decompose into probe-checkable todos, then execute/verify in budgeted rounds until an independent check passes",
	input: inputSchema,
	defaultModel: process.env.TB_MODEL ?? "kimchi-dev/kimi-k2.7",
})
	.then(plan)
	.dountil(
		solveRound,
		(_ctx, last) =>
			(last as { taskComplete: boolean }).taskComplete || (last as { mustStop: boolean }).mustStop,
		{ name: "solve", maxIterations: MAX_ROUNDS + 1 },
	)
	.then(report)
	.commit()
