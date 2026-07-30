import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fermentOneshot from "../ferment-oneshot.workflow.ts"
import { currentGitRef, phaseDiffSince, runVerification } from "../ferment/verify.ts"
import { type AgentStep, forEachNode } from "@kimchi-dev/kimchi-workflows"
import { createTestRun, reply, throws } from "@kimchi-dev/kimchi-workflows/testing"

/**
 * Structural tests for the one-shot ferment solver (`ferment-oneshot.workflow.ts`, this directory —
 * ported here from kimchi-workflows' `test/ferment-oneshot.test.ts` when the workflow itself moved out
 * of that repo), with every agent step scripted and the verification command stubbed — so this pins the
 * WIRING (which stage reads whose output, when a step is re-entered, what the judge is asked) without a
 * model or a container.
 *
 * The thing most worth pinning is the SHAPE of the port: this workflow claims to be kimchi's one-shot
 * ferment minus its nudges, so the tests check both halves of that claim — the ferment's instruction
 * text is present, and its continuation machinery is not.
 *
 * The load-bearing claim as of now: **a step is ONE agent turn that does the work and then answers for
 * it, and no worker is ever dispatched.** kimchi's one-shot orchestrator executes steps directly (31 of
 * 31 `complete_ferment_step` calls across six live runs omit `worker_agent_id`), so a flag is refused
 * back into the session that raised it, which may work some more and answer again.
 */

const gates = (ids: readonly string[], verdict = "pass") =>
	ids.map((id) => ({ id, verdict, rationale: `${id} holds`, evidence: "n/a" }))

const plan = {
	title: "Print ok from cli",
	goal: "Make the cli print ok",
	success_criteria: ["running the cli prints ok and exits 0"],
	constraints: [],
	phases: [
		{
			name: "Fix the cli",
			goal: "the cli prints ok",
			steps: [
				{ description: "patch main.py so it prints ok", verify: "python /app/main.py", budget_tier: "standard" },
				{ description: "remove the debug line", verify: "! grep -q DEBUG /app/main.py", budget_tier: "narrow" },
			],
		},
	],
	questions: [],
	gates: gates(["P1", "P2", "P3"]),
}

const onePhaseOneStep = {
	...plan,
	phases: [
		{
			name: "Fix the cli",
			goal: "the cli prints ok",
			steps: [{ description: "patch main.py so it prints ok", verify: "python /app/main.py" }],
		},
	],
}

/** What a step turn returns: the summary the next steps read, and its own verdicts on its own work. */
const stepPass = { summary: "main.py now prints ok", gates: gates(["S1", "S2", "S3"]) }
const stepFlagged = {
	summary: "claims a file it never touched",
	gates: [
		{
			id: "S1",
			verdict: "flag",
			rationale: "the summary names src/other.py, which is not in the diff",
			evidence: "git diff shows only /app/main.py",
		},
		{ id: "S2", verdict: "pass", rationale: "smoke: runs the cli", evidence: "python /app/main.py" },
		{ id: "S3", verdict: "pass", rationale: "empty input handled", evidence: "returns early" },
	],
}
const phasePass = { summary: "the cli prints ok", gates: gates(["F1", "F2", "F3"]) }
/** kimchi's phase grader: A/B advance, C/D/F refuse and buy a rework. */
const gradeA = { grade: "A", rationale: "the phase goal is met and the diff shows it", recommendations: [] }
const gradeC = {
	grade: "C",
	rationale: "the merge is there but the conflict markers were never checked",
	recommendations: ["grep the working tree for conflict markers and remove any that remain"],
}
const shipPass = { summary: "delivered", gates: gates(["C1", "C2", "C3"]) }
/** The phase rework is the one turn still handed to an agent of its own, and it reports like a worker. */
const reworked = {
	status: "completed",
	summary: "removed the conflict markers",
	steps_completed: ["grepped the tree", "removed two markers"],
	remaining_steps: [],
}

/** A verification that exits 0, standing in for the real `bash -lc` run. */
const verifyOk = () => ({ ran: true, command: "python /app/main.py", exitCode: 0, stdout: "ok\n", stderr: "" })
const verifyFail = () => ({
	ran: true,
	command: "python /app/main.py",
	exitCode: 1,
	stdout: "",
	stderr: "SyntaxError: stray paren",
})

/** The git steps shell out; stub them so the suite stays hermetic. */
const noGit = {
	"phase-start-ref": () => ({ ref: "abc123" }),
	"phase-diff": () => ({
		available: true,
		filesChanged: " _includes/about.md | 2 +-",
		diffSnippet: "@@ -1 +1 @@",
		elidedBytes: 0,
	}),
	"step-start-ref": () => ({ ref: "abc123" }),
}

/**
 * kimchi's `taskInputSchema` here is `Type.Object({ instruction: Type.String() })` — `deadlineIso` was
 * dropped when this workflow moved out of kimchi-workflows, because the harbor adapter's envelope is
 * exactly `{"instruction": ...}` and the extension validates input against this schema before a run
 * starts (`ferment/contract.ts`'s header). Named `roomyInput` from when it also carried a generous
 * deadline; kept as a function, and kept named, so every call site below reads as "input that leaves
 * this run room to work" rather than a bare literal repeated 30-odd times.
 */
const roomyInput = () => ({
	instruction: "Make the cli print ok.",
})

function agentSteps(): Map<string, AgentStep> {
	const steps = new Map<string, AgentStep>()
	forEachNode(fermentOneshot.nodes, (node) => {
		if (node.kind === "step" && node.step.kind === "agent") steps.set(node.step.name, node.step)
	})
	return steps
}

describe("ferment-oneshot: the lifecycle", () => {
	it("runs plan → phase → steps → gates → ship when nothing objects", async () => {
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit, verify: verifyOk },
			agents: {
				plan: [reply(plan)],
				"step-turn": [reply(stepPass), reply(stepPass)],
				"phase-gates": [reply(phasePass)],
				"phase-grade": [reply(gradeA)],
				ship: [reply(shipPass)],
			},
		})

		if (run.status !== "completed") throw new Error(`${run.status} @ ${run.path} :: ${run.error}`)
		expect(run.output).toEqual({ shipped: true, phases: 1, steps: 2, stepsDone: 2 })
		// One turn per step, and nothing else ran: the step turn IS the work.
		expect(run.agent("step-turn").sessions).toBe(2)
		expect(run.agent("judge").sessions).toBe(0) // the plan asked nothing
		expect(run.agent("refine-steps").sessions).toBe(0) // the plan already had steps
		expect(run.agent("verify-judge").sessions).toBe(0) // verification passed, so nothing to triage
	})

	it("refuses a flagged completion straight back into the same session, and dispatches nobody", async () => {
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit, verify: verifyOk },
			agents: {
				plan: [reply(onePhaseOneStep)],
				"step-turn": [reply(stepFlagged), reply(stepPass)],
				"phase-gates": [reply(phasePass)],
				"phase-grade": [reply(gradeA)],
				ship: [reply(shipPass)],
			},
		})

		expect(run.status).toBe("completed")
		// kimchi: "step-level flags don't feed the phase retry/escalation pipeline - they just refuse this
		// single call, and the agent has to fix the underlying issue and re-call" (tools/steps.ts:427). The
		// re-call is the SAME agent, in the same conversation, with the tools it used the first time.
		expect(run.agent("step-turn").sessions).toBe(2)
		expect(run.output).toMatchObject({ shipped: true, stepsDone: 1 })
	})

	it("stops re-entering once the attempt budget is spent, and records the step as not done", async () => {
		// A real verify command, deliberately: kimchi validates gates BEFORE the verification, so a
		// completion that never stops flagging must never reach it. `verify` is left unstubbed so that
		// reaching it would actually shell out.
		const trivialVerify = {
			...onePhaseOneStep,
			phases: [
				{
					name: "Fix the cli",
					goal: "the cli prints ok",
					steps: [{ description: "patch main.py so it prints ok", verify: "true" }],
				},
			],
		}
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit },
			agents: {
				plan: [reply(trivialVerify)],
				"step-turn": [reply(stepFlagged), reply(stepFlagged), reply(stepFlagged)],
				"phase-gates": [reply(phasePass)],
				"phase-grade": [reply(gradeA)],
				ship: [reply(shipPass)],
			},
		})

		expect(run.status).toBe("completed")
		// STEP_MAX_ATTEMPTS re-entries, then the loop stops — kimchi caps it at all, because its
		// orchestrator resolves the step with a planner turn this workflow does not have. One counter, not
		// the product of two: the flag loop and the continuation loop are the same loop now.
		expect(run.agent("step-turn").sessions).toBe(3)
		expect(run.output).toMatchObject({ steps: 1, stepsDone: 0 })

		// "Gate validation runs BEFORE any state mutation" — a refused call never reaches the verification.
		const phaseGatePrompt = run.agent("phase-gates").messages[0] as string
		expect(phaseGatePrompt).toContain("verification: not run — the completion was refused before verification")
	})

	it("triages a non-zero verification, and treats a benign one as done", async () => {
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit, verify: verifyFail },
			agents: {
				plan: [reply(onePhaseOneStep)],
				"step-turn": [reply(stepPass)],
				"verify-judge": [reply({ verdict: "pass", reason: "the grep matched nothing, which is what the step wanted" })],
				"phase-gates": [reply(phasePass)],
				"phase-grade": [reply(gradeA)],
				ship: [reply(shipPass)],
			},
		})

		expect(run.status).toBe("completed")
		expect(run.agent("verify-judge").sessions).toBe(1)
		expect(run.agent("step-turn").sessions).toBe(1) // a benign exit is not a reason to redo the work
		expect(run.output).toMatchObject({ stepsDone: 1 })

		const triagePrompt = run.agent("verify-judge").messages[0] as string
		expect(triagePrompt).toContain("strict verification triage judge")
		expect(triagePrompt).toContain('prefer "fail" — false-pass is the worst outcome')
		expect(triagePrompt).toContain("SyntaxError: stray paren")
	})

	it("sends the step back into its own session when triage calls the failure real", async () => {
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit, verify: verifyFail },
			agents: {
				plan: [reply(onePhaseOneStep)],
				"step-turn": [reply(stepPass), reply(stepPass), reply(stepPass)],
				"verify-judge": [
					reply({ verdict: "fail", reason: "the cli does not run at all" }),
					reply({ verdict: "fail", reason: "still broken" }),
					reply({ verdict: "fail", reason: "still broken" }),
				],
				"phase-gates": [reply(phasePass)],
				"phase-grade": [reply(gradeA)],
				ship: [reply(shipPass)],
			},
		})

		expect(run.status).toBe("completed")
		expect(run.agent("step-turn").sessions).toBe(3)
		// kimchi's rule for a continuation, kept verbatim even though the box it was written for is gone:
		// finish the same bounded work, do not widen it.
		const second = run.agent("step-turn").messages[1] as string
		expect(second).toContain("THIS STEP WAS NOT ACCEPTED, AND THIS IS A BOUNDED CONTINUATION")
		expect(second).toContain("verification failed (exit 1)")
		expect(second).toContain("do not widen the task, and do not start over")
		expect(run.output).toMatchObject({ stepsDone: 0 })
	})

	it("reads a missing triage verdict as failure, the way kimchi does", async () => {
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit, verify: verifyFail },
			agents: {
				plan: [reply(onePhaseOneStep)],
				"step-turn": [reply(stepPass), reply(stepPass), reply(stepPass)],
				// The step is `optional`; a judge that never answered leaves nothing behind. False-pass is the
				// worst outcome available here, so silence must not advance the step.
				"verify-judge": [],
				"phase-gates": [reply(phasePass)],
				"phase-grade": [reply(gradeA)],
				ship: [reply(shipPass)],
			},
		})

		expect(run.status).toBe("completed")
		expect(run.output).toMatchObject({ stepsDone: 0 })
	})

	it("re-enters a step whose turn returned nothing at all", async () => {
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit, verify: verifyOk },
			agents: {
				plan: [reply(onePhaseOneStep)],
				// The turn failed outright: no summary, no verdicts, nothing anyone can account for. kimchi's
				// session would be nudged back to the step; here the next iteration resumes that conversation.
				"step-turn": [throws(new Error("output: the reply was not valid JSON")), reply(stepPass)],
				"phase-gates": [reply(phasePass)],
				"phase-grade": [reply(gradeA)],
				ship: [reply(shipPass)],
			},
		})

		expect(run.status).toBe("completed")
		expect(run.agent("step-turn").sessions).toBe(2)
		expect(run.agent("step-turn").messages[1]).toContain("the step turn returned nothing")
		expect(run.output).toMatchObject({ stepsDone: 1 })
	})

	it("ships false when a ferment-scope gate flags", async () => {
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit, verify: verifyOk },
			agents: {
				plan: [reply(onePhaseOneStep)],
				"step-turn": [reply(stepPass)],
				"phase-gates": [reply(phasePass)],
				"phase-grade": [reply(gradeA)],
				ship: [
					reply({
						summary: "not shippable",
						gates: [
							...gates(["C1", "C2"]),
							{
								id: "C3",
								verdict: "flag",
								rationale: "nothing ever ran the artifact",
								evidence: "every verify is a grep",
							},
						],
					}),
				],
			},
		})

		expect(run.status).toBe("completed")
		expect(run.output).toMatchObject({ shipped: false })
	})
})

describe("ferment-oneshot: the phase grader", () => {
	it("refuses a phase graded below the bar, reworks it, and grades it again", async () => {
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit, verify: verifyOk },
			agents: {
				plan: [reply(onePhaseOneStep)],
				"step-turn": [reply(stepPass)],
				"phase-gates": [reply(phasePass), reply(phasePass)],
				// C on the first closing turn refuses; the rework lands and the second turn grades A.
				"phase-grade": [reply(gradeC), reply(gradeA)],
				"phase-rework": [reply(reworked)],
				ship: [reply(shipPass)],
			},
		})

		expect(run.status).toBe("completed")
		expect(run.agent("phase-rework").sessions).toBe(1)
		expect(run.agent("phase-grade").sessions).toBe(2)
		expect(run.output).toMatchObject({ shipped: true, phases: 1 })

		// The rework is handed exactly what kimchi hands its planner: the grade, the bar, and the fixes.
		const rework = run.agent("phase-rework").messages[0] as string
		expect(rework).toContain("the grader assigned grade C, minimum required is A")
		expect(rework).toContain("grep the working tree for conflict markers")

		// The grader sees the diff, not just the agent's account of it.
		const grader = run.agent("phase-grade").messages[0] as string
		expect(grader).toContain("Verify the agent's claims independently using your tools")
		expect(grader).toContain("--- PHASE DIFF ---")
		expect(grader).toContain("_includes/about.md")
		expect(grader).toContain("agent self-reported — verify independently")
	})

	it("tells the grader how much of the diff it is not being shown", async () => {
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: {
				...noGit,
				verify: verifyOk,
				"phase-diff": () => ({
					available: true,
					filesChanged: " app/main.py | 900 ++++",
					diffSnippet: "@@ head @@\n[... truncated ...]\n@@ tail @@",
					elidedBytes: 41_000,
				}),
			},
			agents: {
				plan: [reply(onePhaseOneStep)],
				"step-turn": [reply(stepPass)],
				"phase-gates": [reply(phasePass)],
				"phase-grade": [reply(gradeA)],
				ship: [reply(shipPass)],
			},
		})

		// A byte cap read as an absence of work is a phase refused for the wrong reason. The grader has
		// tools and is told to verify independently; this is what tells it where it must.
		const grader = run.agent("phase-grade").messages[0] as string
		expect(grader).toContain("This snippet is truncated: 41000 bytes were elided")
		expect(grader).toContain("check it rather than grading it absent")
		expect(run.status).toBe("completed")
	})

	it("accepts a B after a rework, because the bar drops once the phase has been sent back", async () => {
		const gradeB = { grade: "B", rationale: "goal met, one rough edge", recommendations: ["tidy the commit message"] }
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit, verify: verifyOk },
			agents: {
				plan: [reply(onePhaseOneStep)],
				"step-turn": [reply(stepPass)],
				"phase-gates": [reply(phasePass), reply(phasePass)],
				"phase-grade": [reply(gradeC), reply(gradeB)],
				"phase-rework": [reply(reworked)],
				ship: [reply(shipPass)],
			},
		})

		expect(run.status).toBe("completed")
		// A B would have been refused on the first turn and is accepted on the second: kimchi's
		// `minimumAcceptableGrade` is A first, B after rework.
		expect(run.agent("phase-grade").sessions).toBe(2)
		expect(run.agent("phase-rework").sessions).toBe(1)
	})

	it("advances a phase it cannot fix rather than blocking forever", async () => {
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit, verify: verifyOk },
			agents: {
				plan: [reply(onePhaseOneStep)],
				"step-turn": [reply(stepPass)],
				"phase-gates": Array.from({ length: 6 }, () => reply(phasePass)),
				"phase-grade": Array.from({ length: 6 }, () => reply(gradeC)),
				"phase-rework": Array.from({ length: 6 }, () => reply(reworked)),
				ship: [reply(shipPass)],
			},
		})

		expect(run.status).toBe("completed")
		// kimchi: "the agent had its retries; we don't block continuation indefinitely" — MAX_BLOCK_RETRIES
		// reworks, then the grade is accepted and the phase advances with it recorded.
		expect(run.agent("phase-rework").sessions).toBe(3)
		expect(run.agent("phase-grade").sessions).toBe(4)
		expect(run.output).toMatchObject({ phases: 1 })
	})

	it("advances when the grader itself never answered, because an unreachable judge is advisory", async () => {
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit, verify: verifyOk },
			agents: {
				plan: [reply(onePhaseOneStep)],
				"step-turn": [reply(stepPass)],
				"phase-gates": [reply(phasePass)],
				"phase-grade": [], // the step is optional; a grader that returns nothing must not block
				ship: [reply(shipPass)],
			},
		})

		expect(run.status).toBe("completed")
		expect(run.agent("phase-rework").sessions).toBe(0)
		expect(run.output).toMatchObject({ shipped: true, phases: 1 })
	})
})

describe("ferment-oneshot: a step turn that never answers its gates", () => {
	it("advances the step on silence, instead of reading silence as a flag", async () => {
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit, verify: verifyOk },
			agents: {
				plan: [reply(onePhaseOneStep)],
				// The turn ran but produced no parseable payload every time: the step is `optional`, so the
				// engine records `step-failed` and hands `undefined` on.
				"step-turn": [],
				"phase-gates": [reply(phasePass)],
				"phase-grade": [reply(gradeA)],
				ship: [reply(shipPass)],
			},
		})

		expect(run.status).toBe("completed")
		// No verdicts means no FLAG, so the completion is not REFUSED — the step is simply not done, for
		// the recorded reason. kimchi's own rule for an unreachable judge reads the same way: advisory.
		expect(run.agent("step-turn").sessions).toBe(3)
		expect(run.output).toMatchObject({ stepsDone: 0 })

		// And the silence is visible downstream rather than papered over: F1 reads every step's S2 verdict,
		// and the verification still ran, because nothing refused it.
		const phaseGatePrompt = run.agent("phase-gates").messages[0] as string
		expect(phaseGatePrompt).toContain("step gates: (none)")
		expect(phaseGatePrompt).toContain("verification: exit 0 (python /app/main.py)")
	})
})

describe("ferment-oneshot: the gate re-call", () => {
	it("sends a refused step back to the SAME session, with kimchi's refusal text", async () => {
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit, verify: verifyOk },
			agents: {
				plan: [reply(onePhaseOneStep)],
				"step-turn": [reply(stepFlagged), reply(stepPass)],
				"phase-gates": [reply(phasePass)],
				"phase-grade": [reply(gradeA)],
				ship: [reply(shipPass)],
			},
		})

		expect(run.status).toBe("completed")
		// Two executions, ONE conversation: kimchi's orchestrator re-calls complete_ferment_step inside the
		// session that flagged, having fixed the underlying issue itself.
		expect(run.agent("step-turn").sessions).toBe(2)

		const recall = run.agent("step-turn").messages[1] as string
		expect(recall).toContain("cannot complete - agent self-flagged on 1 step gate(s)")
		expect(recall).toContain("⛔ Gate S1:")
		expect(recall).toContain("'omitted' with rationale if a gate truly does not apply")
		// The three ways out, addressed to the agent that did the work — which is what makes "fix it
		// yourself" an instruction it can carry out rather than a request it must forward.
		expect(recall).toContain("You did this work and you flagged it, in this conversation")
		expect(recall).toContain("fix the underlying issue with your tools")
		expect(recall).toContain("vote 'omitted' with a rationale")
		expect(run.output).toMatchObject({ stepsDone: 1 })
	})
})

describe("ferment-oneshot: phase-scope flags", () => {
	it("refuses a flagged phase without buying a grader, and reworks it", async () => {
		const phaseFlagged = {
			summary: "steps done but the trail is hollow",
			gates: [
				{
					id: "F1",
					verdict: "flag",
					rationale: "every step verified by grep only",
					evidence: "S2 was proxy on all four",
				},
				...gates(["F2", "F3"]),
			],
		}
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit, verify: verifyOk },
			agents: {
				plan: [reply(onePhaseOneStep)],
				"step-turn": [reply(stepPass)],
				"phase-gates": [reply(phaseFlagged), reply(phasePass)],
				// Only ONE grade is scripted: the flagged closing turn must not reach the grader at all.
				"phase-grade": [reply(gradeA)],
				"phase-rework": [reply(reworked)],
				ship: [reply(shipPass)],
			},
		})

		expect(run.status).toBe("completed")
		// kimchi: "no block flags from gates or project checks. Run the per-phase LLM grader" — a flagged
		// phase goes straight to the retry pipeline, so the grader spawn is never bought for it.
		expect(run.agent("phase-grade").sessions).toBe(1)
		expect(run.agent("phase-rework").sessions).toBe(1)

		const rework = run.agent("phase-rework").messages[0] as string
		expect(rework).toContain("⛔ Gate F1: every step verified by grep only")
		expect(run.output).toMatchObject({ shipped: true })
	})
})

describe("ferment-oneshot: the interview", () => {
	it("routes decision-blocking questions to the judge and replans with its answers", async () => {
		const asking = {
			...onePhaseOneStep,
			questions: [
				{
					id: "target",
					type: "single",
					question: "Which python should the cli run under?",
					options: [
						{ id: "sys", label: "System python" },
						{ id: "venv", label: "The project venv" },
					],
				},
			],
		}
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit, verify: verifyOk },
			agents: {
				plan: [reply(asking), reply(onePhaseOneStep)],
				judge: [
					reply({
						answers: [{ id: "target", value: "venv" }],
						rationale: "the venv is what the task's own commands use",
					}),
				],
				"step-turn": [reply(stepPass)],
				"phase-gates": [reply(phasePass)],
				"phase-grade": [reply(gradeA)],
				ship: [reply(shipPass)],
			},
		})

		expect(run.status).toBe("completed")
		expect(run.agent("judge").sessions).toBe(1)

		const judgePrompt = run.agent("judge").messages[0] as string
		expect(judgePrompt).toContain("You are standing in for the user during an autonomous ferment run")
		expect(judgePrompt).toContain("Which python should the cli run under?")

		// The planner's second pass is a REPLAN with the decision in hand, not a fresh start.
		const passes = run.agent("plan").messages as string[]
		expect(passes).toHaveLength(2)
		expect(passes[0]).not.toContain("Answers from the judge")
		expect(passes[1]).toContain("Answers from the judge")
		expect(passes[1]).toContain("Which python should the cli run under?: venv")
		expect(passes[1]).toContain("the venv is what the task's own commands use")
		expect(run.agent("plan").sessions).toBe(2) // resumable: one conversation, two executions
	})

	it("keeps interviewing for as long as the planner keeps asking, with no round cap of its own", async () => {
		const asking = { ...onePhaseOneStep, questions: [{ id: "target", type: "text", question: "Which python?" }] }
		const answer = () => reply({ answers: [{ id: "target", value: "venv" }], rationale: "matches the task" })
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit, verify: verifyOk },
			agents: {
				// Four rounds of questions before the planner settles — more than any cap this used to impose.
				plan: [reply(asking), reply(asking), reply(asking), reply(asking), reply(onePhaseOneStep)],
				judge: [answer(), answer(), answer(), answer()],
				"step-turn": [reply(stepPass)],
				"phase-gates": [reply(phasePass)],
				"phase-grade": [reply(gradeA)],
				ship: [reply(shipPass)],
			},
		})

		expect(run.status).toBe("completed")
		// kimchi's interview runs until the planner stops asking; nothing here decides that for it. The run's
		// own deadline (extension.ts) is the backstop, not a round counter in the workflow.
		expect(run.agent("plan").sessions).toBe(5)
		expect(run.agent("judge").sessions).toBe(4)
		expect(run.output).toMatchObject({ phases: 1, stepsDone: 1 })
	})

	it("retries a judge that answers in prose, the way kimchi retries the form call", async () => {
		const asking = {
			...onePhaseOneStep,
			questions: [
				{
					id: "target",
					type: "single",
					question: "Which python?",
					options: [
						{ id: "sys", label: "System" },
						{ id: "venv", label: "Venv" },
					],
				},
			],
		}
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit, verify: verifyOk },
			agents: {
				plan: [reply(asking), reply(onePhaseOneStep)],
				// Two invalid replies, then a good one: kimchi loops the judge call up to
				// ASK_USER_FORM_MAX_ATTEMPTS before giving up on it.
				judge: [
					throws(new Error("output: the reply was not valid JSON")),
					throws(new Error("output: the reply was not valid JSON")),
					reply({ answers: [{ id: "target", value: "venv" }], rationale: "the venv is what the task uses" }),
				],
				"step-turn": [reply(stepPass)],
				"phase-gates": [reply(phasePass)],
				"phase-grade": [reply(gradeA)],
				ship: [reply(shipPass)],
			},
		})

		expect(run.status).toBe("completed")
		expect(run.agent("judge").sessions).toBe(3) // two failures then the answer
		expect(run.agent("plan").messages[1]).toContain("Which python?: venv") // the real answer reached the planner
	})

	it("answers on the judge's behalf with conservative defaults when it never comes back", async () => {
		const asking = {
			...onePhaseOneStep,
			questions: [
				{
					id: "target",
					type: "single",
					question: "Which python?",
					options: [
						{ id: "sys", label: "System" },
						{ id: "venv", label: "Venv" },
					],
				},
				{ id: "force", type: "confirm", question: "Force-push?" },
				{ id: "note", type: "text", question: "Anything else?" },
			],
		}
		const dead = () => throws(new Error("output: the reply was not valid JSON"))
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit, verify: verifyOk },
			agents: {
				plan: [reply(asking), reply(onePhaseOneStep)],
				judge: [dead(), dead(), dead()],
				"step-turn": [reply(stepPass)],
				"phase-gates": [reply(phasePass)],
				"phase-grade": [reply(gradeA)],
				ship: [reply(shipPass)],
			},
		})

		expect(run.status).toBe("completed")
		expect(run.agent("judge").sessions).toBe(3) // every attempt spent

		// kimchi's `defaultAnswerForQuestion`: first option for single/multi, "yes" for confirm, an explicit
		// non-answer for text — never silence, because a question the planner never gets answered is the one
		// outcome the one-shot interview exists to prevent.
		const replan = run.agent("plan").messages[1] as string
		expect(replan).toContain("Which python?: sys")
		expect(replan).toContain("Force-push?: yes")
		expect(replan).toContain("(no answer — judge was unavailable)")
		expect(replan).toContain("Judge was unavailable after 3 attempts")
	})

	it("breaks a phase the plan left empty into steps", async () => {
		const emptyPhase = { ...plan, phases: [{ name: "Fix the cli", goal: "the cli prints ok", steps: [] }] }
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit, verify: verifyOk },
			agents: {
				plan: [reply(emptyPhase)],
				"refine-steps": [reply({ steps: [{ description: "patch main.py", verify: "python /app/main.py" }] })],
				"step-turn": [reply(stepPass)],
				"phase-gates": [reply(phasePass)],
				"phase-grade": [reply(gradeA)],
				ship: [reply(shipPass)],
			},
		})

		expect(run.status).toBe("completed")
		expect(run.agent("refine-steps").sessions).toBe(1)
		expect(run.agent("refine-steps").messages[0]).toContain("into 3–6 concrete steps")
		expect(run.output).toMatchObject({ steps: 1, stepsDone: 1 })
	})
})

describe("ferment-oneshot: what the steps are told", () => {
	it("gives the planner kimchi's planning process and gate contract, and none of its turn machinery", async () => {
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit, verify: verifyOk },
			agents: {
				plan: [reply(onePhaseOneStep)],
				"step-turn": [reply(stepPass)],
				"phase-gates": [reply(phasePass)],
				"phase-grade": [reply(gradeA)],
				ship: [reply(shipPass)],
			},
		})
		const planPrompt = run.agent("plan").messages[0] as string

		// kimchi's own words, kept.
		expect(planPrompt).toContain("You are running a one-shot ferment")
		expect(planPrompt).toContain("Make the cli print ok.")
		expect(planPrompt).toContain("STEP 1 — ORIENT")
		expect(planPrompt).toContain("STEP 5 — PLAN")
		expect(planPrompt).toContain("Does each phase have a verifiable success signal?")

		// kimchi's continuation machinery, dropped: there is no turn to keep alive here.
		expect(planPrompt).not.toContain("Turn discipline")
		expect(planPrompt).not.toContain("Next action:")
		expect(planPrompt).not.toContain("do not stall")
		expect(planPrompt).not.toContain("scope_ferment")
		expect(planPrompt).not.toContain("start_ferment_step")
	})

	it("tells the step turn to do the work itself, with the tier as advice and the start ref to cite from", async () => {
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit, verify: verifyOk },
			agents: {
				plan: [reply(plan)],
				"step-turn": [reply({ ...stepPass, summary: "main.py prints ok now" }), reply(stepPass)],
				"phase-gates": [reply(phasePass)],
				"phase-grade": [reply(gradeA)],
				ship: [reply(shipPass)],
			},
		})

		const [first, second] = run.agent("step-turn").messages as string[]
		expect(first).toContain("📋 Plan first")
		expect(first).toContain("Step 1/2: patch main.py so it prints ok")
		expect(first).toContain("verify: python /app/main.py")
		// kimchi's own direct-execution branch: "or execute the step directly using bash/edit/write".
		expect(first).toContain("Execute this step directly, using bash/edit/write")
		// The tier's limits, stated exactly as kimchi's limitsHint states them — and enforced by nothing,
		// because nothing is dispatched. No landing instruction: there is no box to land inside.
		expect(first).toContain("budget_tier=standard, max_turns=25, max_duration=300s, token_budget=100000")
		expect(first).not.toContain("STOP WORKING AT")
		// kimchi's `stepStartRef`, which is all it ever hands over about a step's diff.
		expect(first).toContain("This step starts at git ref abc123")
		expect(first).toContain("`git diff abc123` is exactly what it changed")
		expect(first).not.toContain("Prior:") // nothing ran before it

		// The second step is a later turn of the SAME conversation, but kimchi's `Prior:` line is sent
		// anyway — it is what the step's own summary is for.
		expect(second).toContain("budget_tier=narrow, max_turns=10, max_duration=180s, token_budget=50000")
		expect(second).toContain('Prior: ✓1 "patch main.py so it prints ok" — main.py prints ok now')
	})

	it("asks the same turn for the gates, and tells the closing turns to go and look", async () => {
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit, verify: verifyOk },
			agents: {
				plan: [reply(onePhaseOneStep)],
				"step-turn": [reply(stepPass)],
				"phase-gates": [reply(phasePass)],
				"phase-grade": [reply(gradeA)],
				ship: [reply(shipPass)],
			},
		})

		// One prompt carries both halves of kimchi's turn: do the work, then answer for it.
		const stepTurnPrompt = run.agent("step-turn").messages[0] as string
		expect(stepTurnPrompt).toContain("Do its work, then run its verification yourself and fix what fails")
		expect(stepTurnPrompt).toContain("Then answer for what you did")
		expect(stepTurnPrompt).toContain("Does the summary describe work present in the diff?")
		expect(stepTurnPrompt).toContain(
			'a "flag" verdict refuses this completion and comes straight back to you to resolve',
		)
		expect(stepTurnPrompt).toContain("write the summary the following steps in this phase will read")

		const phaseGatePrompt = run.agent("phase-gates").messages[0] as string
		expect(phaseGatePrompt).toContain("Did every step's claim verify against real behavior")
		expect(phaseGatePrompt).toContain("verification: exit 0 (python /app/main.py)") // what actually happened
		expect(phaseGatePrompt).toContain("S1:pass")

		const shipPrompt = run.agent("ship").messages[0] as string
		// The phase row must survive the closing LOOP boundary: gates and grade live inside it, this reader
		// does not. A bare read silently produced "(no phase summary)" / "(ungraded)" in a live run.
		expect(shipPrompt).toContain("the cli prints ok") // the F-gate summary
		expect(shipPrompt).toContain("F1:pass")
		expect(shipPrompt).toContain("Is every success criterion from the plan satisfied?")
		expect(shipPrompt).toContain("running the cli prints ok and exits 0") // the P3 checklist
		expect(shipPrompt).toContain("C1 and C3 both ask for evidence, so go and look")
	})

	it("resolves that start ref for real, from the commit taken before the step began", async () => {
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			// `step-start-ref` runs FOR REAL here (against this repository), because the read it makes is the
			// part that can rot silently: a ref it could not resolve degrades to "there is no diff to cite"
			// without anything failing — the exact shape of bug `mustRead` exists to prevent elsewhere.
			steps: { "phase-start-ref": noGit["phase-start-ref"], "phase-diff": noGit["phase-diff"], verify: verifyOk },
			agents: {
				plan: [reply(onePhaseOneStep)],
				"step-turn": [reply(stepPass)],
				"phase-gates": [reply(phasePass)],
				"phase-grade": [reply(gradeA)],
				ship: [reply(shipPass)],
			},
		})

		expect(run.status).toBe("completed")
		const stepTurnPrompt = run.agent("step-turn").messages[0] as string
		expect(stepTurnPrompt).toMatch(/This step starts at git ref [0-9a-f]{40}\./)
		expect(stepTurnPrompt).not.toContain("not a git repository")
	})

	it("says there is nothing to cite when there is no git repository to cite from", async () => {
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			// What a container that is not a git repo produces: the evidence is best-effort, never fatal.
			steps: { ...noGit, verify: verifyOk, "step-start-ref": () => ({ ref: "" }) },
			agents: {
				plan: [reply(onePhaseOneStep)],
				"step-turn": [reply(stepPass)],
				"phase-gates": [reply(phasePass)],
				"phase-grade": [reply(gradeA)],
				ship: [reply(shipPass)],
			},
		})

		const stepTurnPrompt = run.agent("step-turn").messages[0] as string
		expect(stepTurnPrompt).toContain("not a git repository")
		expect(stepTurnPrompt).toContain("cite what you can show instead")
		expect(run.status).toBe("completed")
	})

	it("shows a re-entered turn the verification that has already run, once one has", async () => {
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit, verify: verifyFail },
			agents: {
				plan: [reply(onePhaseOneStep)],
				"step-turn": [reply(stepPass), reply(stepPass), reply(stepPass)],
				"verify-judge": [
					reply({ verdict: "fail", reason: "the cli does not run at all" }),
					reply({ verdict: "fail", reason: "still broken" }),
					reply({ verdict: "fail", reason: "still broken" }),
				],
				"phase-gates": [reply(phasePass)],
				"phase-grade": [reply(gradeA)],
				ship: [reply(shipPass)],
			},
		})

		const [first, second] = run.agent("step-turn").messages as string[]
		// kimchi runs the verify command INSIDE `complete_ferment_step`, after the gates — and a refused call
		// never reaches it. So on a first attempt there is genuinely nothing to show.
		expect(first).not.toContain("exit 1")
		// From the second attempt on, the record exists and is handed over rather than re-run by the agent.
		expect(second).toContain("$ python /app/main.py")
		expect(second).toContain("exit 1")
		expect(second).toContain("SyntaxError: stray paren")
	})

	it("asks the gates in kimchi's own second person, because that is who they are addressed to", async () => {
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit, verify: verifyOk },
			agents: {
				plan: [reply(onePhaseOneStep)],
				"step-turn": [reply(stepPass)],
				"phase-gates": [reply(phasePass)],
				"phase-grade": [reply(gradeA)],
				ship: [reply(shipPass)],
			},
		})

		// `complete_ferment_step` is called by the agent that did the work — one-shot kimchi omits
		// `worker_agent_id` on all 31 of its completions, which `validateLinkedWorker` reads as "the
		// orchestrator executed the step directly" (tools/steps.ts:146). kimchi's registry talks to it in
		// the second person throughout, and this port had rewritten the S gates into the third ("Read the
		// step's summary", "the verify command", "this work"). Same questions, different addressee — and an
		// outside assessor answers them like one: over a live run S3 flagged 21 times against 15 passes, on
		// correct work. The wording IS the mechanism.
		const stepTurnPrompt = run.agent("step-turn").messages[0] as string
		expect(stepTurnPrompt).toContain("Read your own summary.")
		expect(stepTurnPrompt).toContain(
			"If you claim a file you didn't touch, or a function not in the diff — flag this gate.",
		)
		expect(stepTurnPrompt).toContain("Classify your own verify command honestly:")
		expect(stepTurnPrompt).toContain(
			"Return 'flag' if your verify is proxy or sentinel for a step that claims semantic work.",
		)
		expect(stepTurnPrompt).toContain("Name one concrete input or condition that would make your work fail.")
		expect(stepTurnPrompt).toContain("Then state whether your work handles it.")

		const phaseGatePrompt = run.agent("phase-gates").messages[0] as string
		expect(phaseGatePrompt).toContain("List anything you couldn't do, skipped, or deferred — by step or by intent.")
	})
})

describe("ferment-oneshot: nobody is dispatched for a step", () => {
	it("has no worker step at all, so a test cannot even script one", async () => {
		// kimchi's one-shot orchestrator takes the direct branch of `start_ferment_step` every time: across
		// six live runs, all 31 `complete_ferment_step` calls omitted `worker_agent_id`, and the session
		// itself made 108 bash / 16 write / 13 edit calls and spawned nothing. The port used to model the
		// other branch; this is the assertion that stops it coming back.
		await expect(
			createTestRun(fermentOneshot, {
				input: roomyInput(),
				steps: { ...noGit, verify: verifyOk },
				agents: { plan: [reply(onePhaseOneStep)], worker: [reply({ status: "completed" })] },
			}),
		).rejects.toThrow('agent script for "worker": the workflow has no agent step with that name')
	})

	it("spends exactly one agent turn on a step that lands first time", async () => {
		const run = await createTestRun(fermentOneshot, {
			input: roomyInput(),
			steps: { ...noGit, verify: verifyOk },
			agents: {
				plan: [reply(onePhaseOneStep)],
				"step-turn": [reply(stepPass)],
				"phase-gates": [reply(phasePass)],
				"phase-grade": [reply(gradeA)],
				ship: [reply(shipPass)],
			},
		})

		expect(run.status).toBe("completed")
		// The whole step: one turn. It used to be two (a worker, then a gate turn), and a refusal used to
		// buy another of each.
		expect(run.agent("step-turn").sessions).toBe(1)
		expect(run.agent("step-turn").remaining).toBe(0)
	})
})

describe("ferment-oneshot: the shape", () => {
	it("runs every agent step as an isolated subagent that may fail without ending the run", () => {
		const steps = agentSteps()
		const names = [
			"plan",
			"judge",
			"refine-steps",
			"step-turn",
			"verify-judge",
			"phase-gates",
			"phase-grade",
			"phase-rework",
			"ship",
		]

		expect([...steps.keys()].sort()).toEqual([...names].sort())
		for (const name of names) {
			expect(steps.get(name)?.background, name).toBe(true)
			// Optional throughout: a stage that fails must cost that stage, not the run — the run has to
			// reach `report` with whatever landed, because the container is graded either way.
			expect(steps.get(name)?.optional, name).toBe(true)
		}
	})

	it("puts kimchi's orchestrator turns in one session, and leaves every independent judge cold", () => {
		const steps = agentSteps()

		// kimchi owns its gates by TURN, and scope_ferment, the step (start → work → complete),
		// complete_ferment_phase and complete_ferment are all turns of the ONE session that wrote the plan
		// (gate-registry.ts's header; tools/steps.ts:146). Sharing a resume key is how that is said here, and
		// it is what makes the registry's second person true: C1 walks a checklist "declared at scope time"
		// because this session declared it, and S1 asks about "your own summary" because this session did
		// the work.
		for (const name of ["plan", "step-turn", "phase-gates", "ship"]) {
			expect(steps.get(name)?.resumable, name).toBe("orchestrator")
		}

		// The judges stay cold, and this is not the same argument that lost for the step gates. kimchi
		// really does spawn these as separate opinions (judgeStepVerification, judgePhaseGradeViaSubagent),
		// so fresh eyes here is fidelity, not scepticism-by-default. The phase rework is a dispatched agent
		// in kimchi too.
		for (const name of ["judge", "verify-judge", "phase-grade", "phase-rework", "refine-steps"]) {
			expect(steps.get(name)?.resumable, name).toBeUndefined()
		}
	})

	it("puts no wall clock on the step turn, or on anything but the phase rework", () => {
		// kimchi bounds a step turn with NOTHING but the run's deadline: the work and the completion are
		// tool calls inside a session its harness owns. There is no second process to box once the
		// orchestrator does the work, so the worker's tier box and the 180s gate box are both gone — and a
		// step turn that runs away now spends the RUN's clock, which is the same exposure kimchi has.
		expect(agentSteps().get("step-turn")?.maxDurationMs).toBeUndefined()

		// The one constant left, on the one turn still handed to an agent of its own: kimchi's `standard`
		// tier, never a share of anything.
		expect(agentSteps().get("phase-rework")?.maxDurationMs).toBe(300_000)

		for (const [name, step] of agentSteps()) {
			if (name === "phase-rework") continue
			expect(step.maxDurationMs, name).toBeUndefined()
		}
	})

	it("pins no model anywhere, so every step falls through to the session's own default", () => {
		// The workflow used to declare `defaultModel: process.env.TB_MODEL ?? "kimchi-dev/kimi-k2.7"`,
		// which meant the value was never undefined and every step permanently ran a hardcoded model
		// instead of whichever one this benchmark run actually selected. It was removed on the move here
		// (see the workflow's own header, "Deliberately no `defaultModel` here") so per-step model
		// resolution — step `model` → workflow `defaultModel` → the harness/session default — falls all
		// the way through to whatever `--model` the benchmark launched kimchi with. A pin at EITHER level
		// would silently override that selection again and make model comparisons meaningless, so both
		// halves of "nothing is pinned" are worth asserting, not just the workflow-level default.
		expect(fermentOneshot.defaultModel).toBeUndefined()
		for (const [name, step] of agentSteps()) {
			expect(step.model, name).toBeUndefined()
		}
	})
})

/**
 * The one piece with real I/O, which every test above stubs: the step's verify command actually runs,
 * and what it produces is what the gates and the triage judge are shown.
 */
describe("ferment-oneshot: running a verify command", () => {
	it("captures the exit code and both streams", async () => {
		const result = await runVerification("printf ok; printf boom >&2; exit 3", new AbortController().signal)

		expect(result).toMatchObject({ ran: true, exitCode: 3, stdout: "ok", stderr: "boom" })
	})

	it("reports a command that could not run at all as a failure", async () => {
		const result = await runVerification("definitely-not-a-real-binary", new AbortController().signal)

		expect(result.ran).toBe(true)
		expect(result.exitCode).not.toBe(0)
	})

	it("kills the command when the run is cancelled, rather than holding the step open", async () => {
		const controller = new AbortController()
		const running = runVerification("sleep 30", controller.signal)
		controller.abort()

		const result = await running
		expect(result.exitCode).toBe(1)
		expect(result.stderr).toContain("cancelled")
	})
})

/**
 * The other piece with real I/O, and the one the phase grade rests on: what `git` is asked, and what
 * comes back. Run against a throwaway repo rather than stubbed, because the failure that matters here —
 * a diff that omits files the phase CREATED — is invisible to a stub.
 */
describe("ferment-oneshot: gathering the diff evidence", () => {
	const signal = new AbortController().signal
	const originalCwd = process.cwd()
	let repo = ""

	const git = (...args: string[]): void => {
		execFileSync(
			"git",
			["-c", "commit.gpgsign=false", "-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
			{ cwd: repo, stdio: "ignore" },
		)
	}

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "ferment-diff-"))
		git("init", "-q")
		writeFileSync(join(repo, "main.py"), "print('bad')\n")
		git("add", "-A")
		git("commit", "-qm", "base")
		process.chdir(repo)
	})

	afterEach(() => {
		process.chdir(originalCwd)
		rmSync(repo, { recursive: true, force: true })
	})

	it("shows edits AND files the phase created, because a new file is not an empty diff", async () => {
		const ref = await currentGitRef(signal)
		writeFileSync(join(repo, "main.py"), "print('ok')\n")
		writeFileSync(join(repo, "helper.py"), "def helper():\n    return 1\n")

		const diff = await phaseDiffSince(ref, signal)

		expect(diff.available).toBe(true)
		expect(diff.filesChanged).toContain("main.py")
		expect(diff.diffSnippet).toContain("+print('ok')")
		// kimchi lists untracked files with the `?? ` prefix and synthesises a diff against /dev/null for
		// each. Without that, a phase whose whole job was to write new files reads to the grader — and to
		// F2's "cite the specific artifact" — as a phase that changed nothing.
		expect(diff.filesChanged).toContain("?? helper.py")
		expect(diff.diffSnippet).toContain("+def helper():")
		expect(diff.elidedBytes).toBe(0)
	})

	it("keeps the head and the tail when it truncates, and says how much it dropped", async () => {
		const ref = await currentGitRef(signal)
		const body = Array.from({ length: 4000 }, (_, line) => `filler line ${line}`).join("\n")
		writeFileSync(join(repo, "big.py"), `HEAD_SENTINEL\n${body}\nTAIL_SENTINEL\n`)

		const diff = await phaseDiffSince(ref, signal)

		expect(diff.elidedBytes).toBeGreaterThan(0)
		expect(diff.diffSnippet).toContain("HEAD_SENTINEL")
		expect(diff.diffSnippet).toContain("TAIL_SENTINEL")
		expect(diff.diffSnippet).toContain(`diff truncated, ${diff.elidedBytes} bytes elided`)
	})

	it("reports no evidence rather than a wrong one outside a git repo", async () => {
		const bare = mkdtempSync(join(tmpdir(), "ferment-nogit-"))
		try {
			process.chdir(bare)
			expect(await currentGitRef(signal)).toBe("")
			// Which is what the grader prompt turns into "no diff available — inspect files directly".
			expect(await phaseDiffSince("", signal)).toMatchObject({ available: false, diffSnippet: "", elidedBytes: 0 })
		} finally {
			process.chdir(repo)
			rmSync(bare, { recursive: true, force: true })
		}
	})
})
