import { describe, expect, it } from "vitest"
import deepSolve from "../deep-solve.workflow.ts"
import { createTestRun, reply, throws } from "@kimchi-dev/kimchi-workflows/testing"

/**
 * Structural tests for `deep-solve.workflow.ts`, with every agent step scripted — so this pins the
 * WIRING (who may stop the run, what silence means, when the second opinion is bought, what the next
 * round is told) without a model or a container.
 *
 * The claims worth pinning are the ones the workflow's own header makes, because each of them is a
 * decision that a plausible alternative would get backwards:
 *
 *  - **`check` owns the stop.** `execute` has no output schema at all and cannot end the run; a round
 *    stops early only on a checker's verdict.
 *  - **Silence means the opposite thing at the two judges.** A `check` that died at its box has said
 *    nothing, and nothing must read as NOT complete — spend another round rather than declare victory
 *    blind. An `audit` that died has also said nothing, and that must read as NO OBJECTION — because
 *    the first checker already said complete, and reading silence as dissent would let a timeout spin
 *    the loop until the deadline.
 *  - **The second opinion is bought only when it is actionable**: on a round about to stop
 *    successfully, and only while a repair round would still fit.
 *  - **Doom loops are detected outside the model**, by fingerprinting each round's failures.
 *
 * ## Time in these tests
 *
 * Every budget is derived from `deadlineIso`, which the workflow reads against the real `Date.now()`
 * (not the engine's fixed clock), so the helpers below express a deadline as "N seconds from now". With
 * the default `TB_AGENT_TIMEOUT_SEC` of 900 the two thresholds that matter are:
 *
 *  - `auditAffordable` needs ≥ 480s left (audit + a repair round's floor + its check + settle margin);
 *  - `checkpoint.mustStop` fires below 300s (a repair round's floor no longer fits).
 *
 * The names below say which side of those lines a test is on, so a change to the constants shows up as
 * a failing named expectation rather than as an unexplained number.
 */

/** A deadline `seconds` from now, in the ISO-8601 Z form the harbor adapter sends. */
const deadlineIn = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString()

/** Room for several rounds and for the second opinion. */
const roomyInput = () => ({ instruction: "Make the cli print ok.", deadlineIso: deadlineIn(3600) })
/** Enough for another round, too little for the audit to be worth buying. */
const tightInput = () => ({ instruction: "Make the cli print ok.", deadlineIso: deadlineIn(400) })
/** Not enough left for a repair round: this round is the last one. */
const expiringInput = () => ({ instruction: "Make the cli print ok.", deadlineIso: deadlineIn(200) })

/** The one todo's probe and the one risk, named so the assertions below read as claims. */
const PROBE = "python /app/main.py"
const RISK = "'ok' might mean stdout or a file; chose stdout"

const planned = {
	environmentMap: "python 3.13 at /app, main.py is the cli, no services running",
	todos: [{ id: "t1", title: "the cli prints ok", doneWhen: PROBE, expect: "prints 'ok' and exits 0" }],
	risks: [RISK],
}

const complete = {
	unchecked: [],
	todoResults: [{ id: "t1", status: "done", evidence: "$ python /app/main.py\nok" }],
	gaps: [],
	taskComplete: true,
}

const incomplete = {
	unchecked: ["whether the exit status is 0"],
	todoResults: [{ id: "t1", status: "not_done", evidence: "$ python /app/main.py\nSyntaxError" }],
	gaps: [
		{
			what: "main.py does not parse",
			evidence: "$ python /app/main.py\nSyntaxError: stray paren",
			suggestedFix: "remove the stray paren on line 3",
		},
	],
	taskComplete: false,
}

/** A second failing round that is IDENTICAL to `incomplete` — same todo statuses, same gap text. */
const incompleteAgain = incomplete

/** A different failure: the fingerprint must not match `incomplete`. */
const incompleteDifferently = {
	...incomplete,
	gaps: [
		{
			what: "the cli prints OK, not ok",
			evidence: "$ python /app/main.py\nOK",
			suggestedFix: "lower-case the literal",
		},
	],
}

const auditAgrees = { unchecked: [], gaps: [], taskComplete: true }
const auditDissents = {
	unchecked: [],
	gaps: [
		{
			what: "the cli writes to stderr, so a pipe sees nothing",
			evidence: "$ python /app/main.py 2>/dev/null\n(no output)",
			suggestedFix: "print to stdout",
		},
	],
	taskComplete: false,
}

/** `execute` has no output schema — the product is the machine, so any reply is accepted. */
const worked = reply({})

const finalReport = (run: Awaited<ReturnType<typeof createTestRun>>) =>
	run.stepOutput("report") as { taskComplete: boolean; rounds: number; remainingSec: number }

const lastCheckpoint = (run: Awaited<ReturnType<typeof createTestRun>>) =>
	run.stepOutput("solve/checkpoint") as {
		taskComplete: boolean
		mustStop: boolean
		stuck: boolean
		round: number
	}

// -- the contract with the adapter ------------------------------------------------------------------

describe("deep-solve: the input contract", () => {
	it("refuses to start without the deadline, which is the whole basis of its scheduling", async () => {
		// PiWorkflowAgent reconstructs harbor's agent timeout and sends this; WorkflowAgent (kimchi)
		// sends `{instruction}` alone. This failing loudly in the first second — rather than the workflow
		// inventing a clock — is what keeps `agent=kimchi-workflow workflow=deep-solve` from quietly
		// producing a run scheduled against nothing.
		const run = await createTestRun(deepSolve, {
			input: { instruction: "Make the cli print ok." },
			agents: { plan: [reply(planned)], execute: [worked], check: [reply(complete)] },
		})

		expect(run.status).toBe("crashed")
		expect(run.error).toContain("must have required properties deadlineIso")
	})
})

// -- who may stop the run ---------------------------------------------------------------------------

describe("deep-solve: the stop rule", () => {
	it("runs plan → execute → check → audit → report and stops on two agreeing verdicts", async () => {
		const run = await createTestRun(deepSolve, {
			input: roomyInput(),
			agents: {
				plan: [reply(planned)],
				execute: [worked],
				check: [reply(complete)],
				audit: [reply(auditAgrees)],
			},
		})

		if (run.status !== "completed") throw new Error(`${run.status} @ ${run.path} :: ${run.error}`)
		expect(finalReport(run)).toMatchObject({ taskComplete: true, rounds: 1 })
	})

	it("goes round again on a 'not complete' verdict, and stops when the next check passes", async () => {
		const run = await createTestRun(deepSolve, {
			input: roomyInput(),
			agents: {
				plan: [reply(planned)],
				execute: [worked, worked],
				check: [reply(incomplete), reply(complete)],
				audit: [reply(auditAgrees)],
			},
		})

		expect(run.status).toBe("completed")
		expect(finalReport(run)).toMatchObject({ taskComplete: true, rounds: 2 })
	})

	it("never lets `execute` end the run: it has no verdict to give", async () => {
		// `execute` deliberately has no output schema, so there is no field it could set to stop early.
		// A round ends on the checker's verdict and on nothing else.
		const run = await createTestRun(deepSolve, {
			input: roomyInput(),
			agents: {
				plan: [reply(planned)],
				execute: [reply({ taskComplete: true, done: true }), worked],
				check: [reply(incomplete), reply(complete)],
				audit: [reply(auditAgrees)],
			},
		})

		expect(run.status).toBe("completed")
		expect(finalReport(run).rounds).toBe(2)
	})
})

// -- what silence means -----------------------------------------------------------------------------

describe("deep-solve: a judge that says nothing", () => {
	it("reads a dead `check` as NOT complete and spends another round", async () => {
		// A checker killed at its box has said nothing. Declaring victory on that is the expensive
		// error — the run stops holding exactly the budget that would have fixed the task.
		const run = await createTestRun(deepSolve, {
			input: roomyInput(),
			agents: {
				plan: [reply(planned)],
				execute: [worked, worked],
				check: [throws("check timed out"), reply(complete)],
				audit: [reply(auditAgrees)],
			},
		})

		expect(run.status).toBe("completed")
		expect(finalReport(run).rounds).toBe(2)
	})

	it("reads a dead `audit` as NO OBJECTION and stops on the first verdict", async () => {
		// The opposite reading, on purpose: the first checker already said complete, so treating audit
		// silence as dissent would let a timeout spin this loop until the deadline.
		const run = await createTestRun(deepSolve, {
			input: roomyInput(),
			agents: {
				plan: [reply(planned)],
				execute: [worked],
				check: [reply(complete)],
				audit: [throws("audit timed out")],
			},
		})

		expect(run.status).toBe("completed")
		expect(finalReport(run)).toMatchObject({ taskComplete: true, rounds: 1 })
	})

	it("survives a dead `plan` and solves the task from the statement alone", async () => {
		// A lost plan degrades the run; it must not end it.
		const run = await createTestRun(deepSolve, {
			input: roomyInput(),
			agents: {
				plan: [throws("planner died")],
				execute: [worked],
				check: [reply(complete)],
				audit: [reply(auditAgrees)],
			},
		})

		expect(run.status).toBe("completed")
		expect(run.agent("execute").messages[0]).toContain("(no plan was produced")
	})
})

// -- the second opinion -----------------------------------------------------------------------------

describe("deep-solve: when the audit is bought", () => {
	it("is skipped entirely on a round a failing check already sends around again", async () => {
		// That is what keeps it affordable: it is paid for only on a round about to stop.
		const run = await createTestRun(deepSolve, {
			input: roomyInput(),
			agents: {
				plan: [reply(planned)],
				execute: [worked, worked],
				check: [reply(incomplete), reply(complete)],
				audit: [reply(auditAgrees)],
			},
		})

		expect(run.status).toBe("completed")
		expect(run.agent("audit").sessions).toBe(1)
	})

	it("is skipped when a disagreement would no longer be actionable", async () => {
		// Below the affordability line the audit can only confirm, or deliver news nobody can act on.
		const run = await createTestRun(deepSolve, {
			input: tightInput(),
			agents: {
				plan: [reply(planned)],
				execute: [worked],
				check: [reply(complete)],
				audit: [reply(auditDissents)],
			},
		})

		expect(run.status).toBe("completed")
		expect(run.agent("audit").sessions).toBe(0)
		expect(finalReport(run).taskComplete).toBe(true)
	})

	it("overturns a 'complete' only on demonstrated failure, and buys a repair round", async () => {
		const run = await createTestRun(deepSolve, {
			input: roomyInput(),
			agents: {
				plan: [reply(planned)],
				execute: [worked, worked],
				check: [reply(complete), reply(complete)],
				audit: [reply(auditDissents), reply(auditAgrees)],
			},
		})

		expect(run.status).toBe("completed")
		expect(finalReport(run)).toMatchObject({ taskComplete: true, rounds: 2 })
	})

	it("hands the dissent to the repair round, since the first checker described nothing wrong", async () => {
		// When the audit is why this round exists, its findings are the ONLY description of the defect.
		const run = await createTestRun(deepSolve, {
			input: roomyInput(),
			agents: {
				plan: [reply(planned)],
				execute: [worked, worked],
				check: [reply(complete), reply(complete)],
				audit: [reply(auditDissents), reply(auditAgrees)],
			},
		})

		const secondPrompt = run.agent("execute").messages[1]
		expect(secondPrompt).toContain("the cli writes to stderr")
		expect(secondPrompt).toContain("AN INDEPENDENT CHECK FOUND PROBLEMS")
	})

	it("is never given the todo list, so it cannot repeat the first checker's method", async () => {
		const run = await createTestRun(deepSolve, {
			input: roomyInput(),
			agents: {
				plan: [reply(planned)],
				execute: [worked],
				check: [reply(complete)],
				audit: [reply(auditAgrees)],
			},
		})

		const auditPrompt = run.agent("audit").messages[0]
		expect(auditPrompt).not.toContain(PROBE)
		expect(auditPrompt).toContain("You are deliberately NOT given their checklist")
	})
})

// -- the doom-loop detector -------------------------------------------------------------------------

describe("deep-solve: two identical failures", () => {
	it("raises `stuck` and tells the next round to change strategy", async () => {
		const run = await createTestRun(deepSolve, {
			input: roomyInput(),
			agents: {
				plan: [reply(planned)],
				execute: [worked, worked, worked],
				check: [reply(incomplete), reply(incompleteAgain), reply(complete)],
				audit: [reply(auditAgrees)],
			},
		})

		expect(run.status).toBe("completed")
		// Round 3's prompt is the first written after two identical failures.
		const thirdPrompt = run.agent("execute").messages[2]
		expect(thirdPrompt).toContain("THE LAST TWO ROUNDS FAILED IDENTICALLY")
	})

	it("does not raise it when the round failed differently", async () => {
		const run = await createTestRun(deepSolve, {
			input: roomyInput(),
			agents: {
				plan: [reply(planned)],
				execute: [worked, worked, worked],
				check: [reply(incomplete), reply(incompleteDifferently), reply(complete)],
				audit: [reply(auditAgrees)],
			},
		})

		expect(run.status).toBe("completed")
		expect(run.agent("execute").messages[2]).not.toContain("THE LAST TWO ROUNDS FAILED IDENTICALLY")
	})
})

// -- the clock --------------------------------------------------------------------------------------

describe("deep-solve: the deadline", () => {
	it("ends the run when a repair round no longer fits, rather than starting one it cannot finish", async () => {
		const run = await createTestRun(deepSolve, {
			input: expiringInput(),
			agents: {
				plan: [reply(planned)],
				execute: [worked],
				check: [reply(incomplete)],
			},
		})

		expect(run.status).toBe("completed")
		expect(lastCheckpoint(run)).toMatchObject({ mustStop: true, taskComplete: false, round: 1 })
		// The run reports the truth about itself: it stopped on the clock, not on a passing check.
		expect(finalReport(run).taskComplete).toBe(false)
	})

	it("quotes each stage its own budget, because agents cannot estimate time", async () => {
		const run = await createTestRun(deepSolve, {
			input: roomyInput(),
			agents: {
				plan: [reply(planned)],
				execute: [worked],
				check: [reply(complete)],
				audit: [reply(auditAgrees)],
			},
		})

		for (const step of ["plan", "execute", "check", "audit"]) {
			expect(run.agent(step).messages[0]).toContain("CLOCK: aim to finish THIS step in about")
		}
	})
})

// -- what each stage is told ------------------------------------------------------------------------

describe("deep-solve: context injection", () => {
	it("maps the environment once and injects it, instead of paying to rediscover it", async () => {
		const run = await createTestRun(deepSolve, {
			input: roomyInput(),
			agents: {
				plan: [reply(planned)],
				execute: [worked],
				check: [reply(complete)],
				audit: [reply(auditAgrees)],
			},
		})

		expect(run.agent("execute").messages[0]).toContain(planned.environmentMap)
	})

	it("tells the checker what the planner was unsure about, so it probes there hardest", async () => {
		const run = await createTestRun(deepSolve, {
			input: roomyInput(),
			agents: {
				plan: [reply(planned)],
				execute: [worked],
				check: [reply(complete)],
				audit: [reply(auditAgrees)],
			},
		})

		expect(run.agent("check").messages[0]).toContain(RISK)
	})

	it("keeps the planning stage read-only: the work it did would escape verification", async () => {
		const run = await createTestRun(deepSolve, {
			input: roomyInput(),
			agents: {
				plan: [reply(planned)],
				execute: [worked],
				check: [reply(complete)],
				audit: [reply(auditAgrees)],
			},
		})

		expect(run.agent("plan").messages[0]).toContain("THIS STAGE IS READ-ONLY")
	})

	it("tells every acting and judging stage how this benchmark actually grades", async () => {
		const run = await createTestRun(deepSolve, {
			input: roomyInput(),
			agents: {
				plan: [reply(planned)],
				execute: [worked],
				check: [reply(complete)],
				audit: [reply(auditAgrees)],
			},
		})

		for (const step of ["plan", "execute"]) {
			expect(run.agent(step).messages[0]).toContain("hidden automated tests inspect the FINAL STATE")
		}
	})
})

// -- session shape ----------------------------------------------------------------------------------

describe("deep-solve: sessions", () => {
	it("continues `execute`'s own conversation across rounds, so progress is sustained", async () => {
		const run = await createTestRun(deepSolve, {
			input: roomyInput(),
			agents: {
				plan: [reply(planned)],
				execute: [worked, worked],
				check: [reply(incomplete), reply(complete)],
				audit: [reply(auditAgrees)],
			},
		})

		expect(run.agent("execute").messages).toHaveLength(2)
		expect(run.agent("execute").messages[1]).toContain("YOU HAVE BEEN HERE BEFORE")
	})

	it("starts `check` cold every round: its entire value is fresh eyes", async () => {
		const run = await createTestRun(deepSolve, {
			input: roomyInput(),
			agents: {
				plan: [reply(planned)],
				execute: [worked, worked],
				check: [reply(incomplete), reply(complete)],
				audit: [reply(auditAgrees)],
			},
		})

		// One session per round — a resumed checker would be re-reading its own prior conclusions.
		expect(run.agent("check").sessions).toBe(2)
	})
})
