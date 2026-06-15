import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vitest"
import type { Ferment, FermentStatus } from "../../ferment/types.js"
import { runAsAgentWorker } from "../agent-worker-context.js"
import { registerAgents } from "../agents/personas/agent-types.js"
import { setPermissionMode } from "../permissions/mode-controller.js"
import { buildFermentPromptBlock } from "./prompt-block.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "./runtime.js"
import type { ContinuationPolicy } from "./state.js"

const TEST_SESSION_ID = "test-session"

function makeMockCtx(): ExtensionContext {
	// Set up permission mode for the test session
	setPermissionMode(TEST_SESSION_ID, "default", "user")
	return { sessionManager: { getSessionId: () => TEST_SESSION_ID } } as unknown as ExtensionContext
}

function makePi(oneshot: boolean): ExtensionAPI {
	return {
		getFlag: (name: string) => (name === "ferment-oneshot" ? oneshot : undefined),
	} as unknown as ExtensionAPI
}

const PI_NORMAL = makePi(false)
const PI_ONESHOT = makePi(true)

const NOW = "2026-01-01T00:00:00.000Z"

function makeFerment(overrides: Partial<Ferment> = {}): Ferment {
	return {
		id: "ferment-1",
		name: "Runtime Plan",
		status: "running",
		worktree: { path: "/repo" },
		scoping: {},
		phases: [
			{
				id: "phase-1",
				index: 1,
				name: "Previous Phase",
				goal: "Build the base",
				status: "completed",
				steps: [],
				grade: {
					grade: "D",
					rationale: "Important requirements were missed.",
					deltas: [
						{
							category: "scope",
							expected: "Handle edge cases",
							actual: "Only happy path",
							severity: "major",
						},
					],
					gradedAt: NOW,
				},
			},
		],
		decisions: [],
		memories: [],
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	}
}

function makeRuntime(fermentOverrides: Partial<Ferment> = {}, policy: ContinuationPolicy = "manual"): FermentRuntime {
	const ferment = makeFerment(fermentOverrides)
	return {
		...createDefaultFermentRuntime(),
		getActive: () => ferment,
		getContinuationPolicy: () => policy,
	}
}

function makeNoActiveFermentRuntime(): FermentRuntime {
	return {
		...createDefaultFermentRuntime(),
		getActive: () => undefined,
	}
}

const STATE_MACHINE_HEADER = "**State machine:**"
const KNOWLEDGE_HEADER = "**Knowledge capture:**"
const FILE_RULE = "NEVER write, edit, or read files yourself"
const CREATE_GUARD = "There is no `create_ferment` tool"
const PAUSED_HEADER = "## Ferment Paused"
const PAUSED_RULE = "Do NOT call any ferment tools"

describe("buildFermentPromptBlock", () => {
	afterEach(() => {
		registerAgents(new Map())
	})

	describe("ferment-oneshot=false — injection set", () => {
		const cases: Array<{ status: FermentStatus; defined: boolean }> = [
			{ status: "draft", defined: false },
			{ status: "planned", defined: true },
			{ status: "running", defined: true },
			{ status: "paused", defined: true },
			{ status: "complete", defined: false },
			{ status: "abandoned", defined: false },
		]

		for (const c of cases) {
			it(`${c.defined ? "returns text" : "returns undefined"} for status=${c.status}`, () => {
				const out = buildFermentPromptBlock(makeMockCtx(), PI_NORMAL, makeRuntime({ status: c.status }))
				if (c.defined) {
					expect(out).toBeDefined()
					expect(out).not.toBe("")
				} else {
					expect(out).toBeUndefined()
				}
			})
		}

		it("returns idle hint when no ferment is active", () => {
			const out = buildFermentPromptBlock(makeMockCtx(), PI_NORMAL, makeNoActiveFermentRuntime())
			expect(out).toContain("Ferment Workflow")
			expect(out).toContain("The tool asks the user for explicit host confirmation")
			expect(out).toContain("In yolo permissions mode, the host auto-approves")
			expect(out).not.toContain("questionnaire")
			expect(out).not.toContain("ferment_start_approval")
			expect(out).toContain("`intent` containing the full original user request")
			expect(out).toContain("Never block")
		})
	})

	describe("ferment-oneshot=true — injection set", () => {
		const cases: Array<{ status: FermentStatus; defined: boolean }> = [
			{ status: "draft", defined: true },
			{ status: "planned", defined: true },
			{ status: "running", defined: true },
			{ status: "paused", defined: true },
			{ status: "complete", defined: false },
			{ status: "abandoned", defined: false },
		]

		for (const c of cases) {
			it(`${c.defined ? "returns text" : "returns undefined"} for status=${c.status}`, () => {
				const out = buildFermentPromptBlock(makeMockCtx(), PI_ONESHOT, makeRuntime({ status: c.status }))
				if (c.defined) {
					expect(out).toBeDefined()
					expect(out).not.toBe("")
				} else {
					expect(out).toBeUndefined()
				}
			})
		}

		it("returns planner supplement for draft status (one-shot scoping must not break)", () => {
			const out = buildFermentPromptBlock(makeMockCtx(), PI_ONESHOT, makeRuntime({ status: "draft" }))
			expect(out).toContain(STATE_MACHINE_HEADER)
			expect(out).toContain(FILE_RULE)
		})
	})

	describe("rule-survival — load-bearing substrings", () => {
		const PI_BY_NAME = { normal: PI_NORMAL, oneshot: PI_ONESHOT }

		const plannerStatuses: FermentStatus[] = ["planned", "running"]
		for (const status of plannerStatuses) {
			it(`preserves planner rules for status=${status} regardless of ferment-oneshot flag`, () => {
				for (const surface of ["normal", "oneshot"] as const) {
					const out = buildFermentPromptBlock(makeMockCtx(), PI_BY_NAME[surface], makeRuntime({ status }))
					expect(out, `surface=${surface} status=${status}`).toContain(STATE_MACHINE_HEADER)
					expect(out, `surface=${surface} status=${status}`).toContain(FILE_RULE)
					expect(out, `surface=${surface} status=${status}`).toContain(KNOWLEDGE_HEADER)
					expect(out, `surface=${surface} status=${status}`).toContain("## Upfront Contract")
				}
			})
		}

		it("preserves planner rules for draft when ferment-oneshot is set", () => {
			const out = buildFermentPromptBlock(makeMockCtx(), PI_ONESHOT, makeRuntime({ status: "draft" }))
			expect(out).toContain(STATE_MACHINE_HEADER)
			expect(out).toContain(FILE_RULE)
			expect(out).toContain(KNOWLEDGE_HEADER)
			expect(out).toContain(CREATE_GUARD)
		})

		it("tells planners that ferment creation is host-owned", () => {
			const out = buildFermentPromptBlock(makeMockCtx(), PI_NORMAL, makeRuntime({ status: "running" }))
			expect(out).toContain(CREATE_GUARD)
			expect(out).toContain('/ferment new "..."')
			expect(out).toContain("Do not search for, retry with, or invent variants")
			expect(out).toContain("new_ferment")
		})

		it("returns undefined for subagent workers (no idle hint, no planner supplement)", async () => {
			await runAsAgentWorker(async () => {
				expect(buildFermentPromptBlock(makeMockCtx(), PI_NORMAL, makeNoActiveFermentRuntime())).toBeUndefined()
				expect(buildFermentPromptBlock(makeMockCtx(), PI_NORMAL, makeRuntime({ status: "running" }))).toBeUndefined()
				expect(buildFermentPromptBlock(makeMockCtx(), PI_ONESHOT, makeRuntime({ status: "draft" }))).toBeUndefined()
			})
		})

		it("returns undefined when permissions mode is plan (no idle hint)", () => {
			const ctx = makeMockCtx()
			const sessionId = ctx.sessionManager.getSessionId()
			setPermissionMode(sessionId, "plan", "user")
			expect(buildFermentPromptBlock(ctx, PI_NORMAL, makeNoActiveFermentRuntime())).toBeUndefined()
		})
		it("preserves paused warning for status=paused regardless of ferment-oneshot flag", () => {
			for (const surface of ["normal", "oneshot"] as const) {
				const out = buildFermentPromptBlock(makeMockCtx(), PI_BY_NAME[surface], makeRuntime({ status: "paused" }))
				expect(out, `surface=${surface}`).toContain(PAUSED_HEADER)
				expect(out, `surface=${surface}`).toContain(PAUSED_RULE)
			}
		})

		it("warns against turning fixed interfaces into configurable options", () => {
			const out = buildFermentPromptBlock(makeMockCtx(), PI_ONESHOT, makeRuntime()) ?? ""
			expect(out).toContain("fixed output path")
			expect(out).toContain("fixed runtime interface")
			expect(out).toContain("extra CLI argument")
			expect(out).toContain("config option")
			expect(out).toContain("flexible interface")
		})

		it("includes Upfront Contract directives mentioning propose_ferment_scoping", () => {
			const out = buildFermentPromptBlock(makeMockCtx(), PI_ONESHOT, makeRuntime({}, "automated")) ?? ""
			expect(out).toContain("Upfront Contract")
			expect(out).toContain("do not ask the user to confirm phase advancement")
			expect(out).toContain("propose_ferment_scoping")
			expect(out).toContain("Ask clarifying questions only when the answer is decision-blocking")
			expect(out).toContain('<scoping_sequence required="true">')
			expect(out).toContain("STEP 1")
			expect(out).toContain("ORIENT")
			expect(out).toContain("STEP 2")
			expect(out).toContain("INTERVIEW")
			expect(out).toContain("STEP 3")
			expect(out).toContain("COMPLETION CRITERIA")
			expect(out).toContain("recommended: true")
			expect(out).toContain("choose the right style with `type`")
			expect(out).toContain("`single` for one choice")
			expect(out).toContain("`confirm` for yes/no")
			expect(out).toContain("`multi` for multi-select")
			expect(out).toContain("`text` for enter-your-own only")
			expect(out).toContain("Hard limits: emit at most 3 questions")
			expect(out).toContain("outcome boundary")
			expect(out).toContain("Do not create phases for asking or reading scoping answers")
			expect(out).toContain("Phases are executable implementation slices")
			expect(out).toContain("markdown style")
			expect(out).toContain("Ask follow-up questions only for genuinely new")
			expect(out).toContain("full `gates` array")
			expect(out).toContain("exactly P1, P2, and P3")
			expect(out).toContain("`id`, `verdict`, `rationale`, and `evidence`")
			expect(out).toContain("Never emit a partial gates array")
			expect(out).toContain('After `propose_ferment_scoping` returns "Plan saved"')
		})

		it("guides orient-interview discovery before proposing scoping", () => {
			const out = buildFermentPromptBlock(makeMockCtx(), PI_ONESHOT, makeRuntime()) ?? ""
			expect(out).toContain("follow the shared discovery guidance in the Upfront Contract")
			// Orient-interview scoping sequence
			expect(out).toContain('<scoping_sequence required="true">')
			expect(out).toContain("STEP 1")
			expect(out).toContain("ORIENT")
			expect(out).toContain("STEP 2")
			expect(out).toContain("INTERVIEW")
			expect(out).toContain("iterative rounds")
			expect(out).toContain("REFLECT before continuing")
			expect(out).toContain("STEP 4")
			expect(out).toContain("DEEP EXPLORATION")
			expect(out).toContain("MAX 2 TURNS")
			expect(out).toContain("targeted search to find the")
			expect(out).toContain("Skip this step for greenfield tasks")
			expect(out).toContain("record why in assumptions")
			expect(out).toContain("Use Explore subagents for broader or parallel discovery")
			expect(out).toContain('subagent_type: "Explore"')
			expect(out).toContain("token_budget: 120000")
			expect(out).toContain("run_in_background: true")
			expect(out).toContain("do not retry the same broad task")
			expect(out).toContain("spawn a narrower replacement only if that missing fact is plan-blocking")
			expect(out).toContain("continue with direct targeted reads")
			expect(out).toContain('otherwise become an "explore", "find the existing pattern"')
			expect(out).toContain("The plan you propose should reflect the discovered files")
			expect(out).toContain("all P1/P2/P3 gates")
		})

		it("uses manual phase-boundary instructions under manual continuation policy", () => {
			const out = buildFermentPromptBlock(makeMockCtx(), PI_NORMAL, makeRuntime({}, "manual")) ?? ""
			expect(out).toContain("Manual continuation policy is active")
			expect(out).toContain("ask the user before activating the next phase")
			expect(out).toContain("do not call `activate_ferment_phase` until they say continue")
			expect(out).not.toContain("do not ask the user to confirm phase advancement")
		})

		it("uses automated cross-phase instructions under automated continuation policy", () => {
			const out = buildFermentPromptBlock(makeMockCtx(), PI_NORMAL, makeRuntime({}, "automated")) ?? ""
			expect(out).toContain("Automated continuation policy is active")
			expect(out).toContain("continue across phase boundaries")
			expect(out).toContain("do not ask the user to confirm phase advancement")
		})

		it("lists default subagent types when the registry is populated", () => {
			// registerAgents loads DEFAULT_AGENTS, mirroring session_start in the
			// agents extension.
			registerAgents(new Map())

			const out = buildFermentPromptBlock(makeMockCtx(), PI_ONESHOT, makeRuntime()) ?? ""
			expect(out).toContain("Available subagent types")
			expect(out).toContain("**Explore**")
		})

		it("uses the active ferment name in the planner role line", () => {
			const out = buildFermentPromptBlock(makeMockCtx(), PI_ONESHOT, makeRuntime()) ?? ""
			expect(out).toContain('ferment "Runtime Plan"')
			// Phase-grade-based self-improvement was removed when per-phase grading
			// went away. Corrective-step pipeline now lives in complete_ferment_phase
			// retries — surfaced via tool error text, not via a prompt section.
			expect(out).not.toContain("## Self-Improvement Feedback")
		})

		it("does not prescribe concrete worker models — orchestrator owns that policy now", () => {
			const out = buildFermentPromptBlock(makeMockCtx(), PI_ONESHOT, makeRuntime()) ?? ""
			expect(out).not.toContain("minimax-m2.7")
			expect(out).not.toContain("kimi-k2.5")
			expect(out).not.toContain("worker_model")
		})

		it("keeps phase tagging out of the pre-ferment classification path", () => {
			const out = buildFermentPromptBlock(makeMockCtx(), PI_NORMAL, makeNoActiveFermentRuntime()) ?? ""
			expect(out).toContain("Do not call `set_phase`")
			expect(out).toContain("*until* you have classified the request")
			expect(out).toContain("called `request_ferment_workflow`")
			expect(out).toContain("open-ended analysis of an existing app")
			expect(out).toContain("request the ferment workflow before analysis, file reads, or phase tagging")
			expect(out).toContain("the host handles confirmation and queues scoping")
		})
	})

	describe("paused isolation — mutual exclusion at runtime", () => {
		const PI_BY_NAME = { normal: PI_NORMAL, oneshot: PI_ONESHOT }

		it("paused renders the warning without planner supplement substrings", () => {
			for (const surface of ["normal", "oneshot"] as const) {
				const out = buildFermentPromptBlock(makeMockCtx(), PI_BY_NAME[surface], makeRuntime({ status: "paused" })) ?? ""
				expect(out, `surface=${surface}`).toContain(PAUSED_RULE)
				expect(out, `surface=${surface}`).not.toContain(STATE_MACHINE_HEADER)
				expect(out, `surface=${surface}`).not.toContain(KNOWLEDGE_HEADER)
				expect(out, `surface=${surface}`).not.toContain("## Upfront Contract")
			}
		})

		const runningLike: FermentStatus[] = ["planned", "running"]
		for (const status of runningLike) {
			it(`status=${status} renders the planner supplement without the paused warning`, () => {
				for (const surface of ["normal", "oneshot"] as const) {
					const out = buildFermentPromptBlock(makeMockCtx(), PI_BY_NAME[surface], makeRuntime({ status })) ?? ""
					expect(out, `surface=${surface} status=${status}`).toContain(STATE_MACHINE_HEADER)
					expect(out, `surface=${surface} status=${status}`).not.toContain(PAUSED_HEADER)
					expect(out, `surface=${surface} status=${status}`).not.toContain(PAUSED_RULE)
				}
			})
		}
	})

	describe("parity between ferment-oneshot flag states", () => {
		const PARITY_SUBSTRINGS = [STATE_MACHINE_HEADER, FILE_RULE, KNOWLEDGE_HEADER]

		it("both flag states emit the same load-bearing planner substrings for an active running ferment", () => {
			const runtime = makeRuntime({ status: "running" })

			const normalText = buildFermentPromptBlock(makeMockCtx(), PI_NORMAL, runtime) ?? ""
			const oneshotText = buildFermentPromptBlock(makeMockCtx(), PI_ONESHOT, runtime) ?? ""

			for (const sub of PARITY_SUBSTRINGS) {
				expect(normalText, `ferment-oneshot=false missing: ${sub}`).toContain(sub)
				expect(oneshotText, `ferment-oneshot=true missing: ${sub}`).toContain(sub)
			}
		})
	})
})
