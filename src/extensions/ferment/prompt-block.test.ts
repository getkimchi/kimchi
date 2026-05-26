import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vitest"
import type { Ferment, FermentStatus } from "../../ferment/types.js"
import { registerAgents } from "../agents/personas/agent-types.js"
import { buildFermentPromptBlock } from "./prompt-block.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "./runtime.js"
import type { ContinuationPolicy } from "./state.js"

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
				const out = buildFermentPromptBlock(PI_NORMAL, makeRuntime({ status: c.status }))
				if (c.defined) {
					expect(out).toBeDefined()
					expect(out).not.toBe("")
				} else {
					expect(out).toBeUndefined()
				}
			})
		}

		it("returns undefined when no ferment is active", () => {
			expect(buildFermentPromptBlock(PI_NORMAL, makeNoActiveFermentRuntime())).toBeUndefined()
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
				const out = buildFermentPromptBlock(PI_ONESHOT, makeRuntime({ status: c.status }))
				if (c.defined) {
					expect(out).toBeDefined()
					expect(out).not.toBe("")
				} else {
					expect(out).toBeUndefined()
				}
			})
		}

		it("returns undefined when no ferment is active", () => {
			expect(buildFermentPromptBlock(PI_ONESHOT, makeNoActiveFermentRuntime())).toBeUndefined()
		})

		it("returns planner supplement for draft status (one-shot scoping must not break)", () => {
			const out = buildFermentPromptBlock(PI_ONESHOT, makeRuntime({ status: "draft" }))
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
					const out = buildFermentPromptBlock(PI_BY_NAME[surface], makeRuntime({ status }))
					expect(out, `surface=${surface} status=${status}`).toContain(STATE_MACHINE_HEADER)
					expect(out, `surface=${surface} status=${status}`).toContain(FILE_RULE)
					expect(out, `surface=${surface} status=${status}`).toContain(KNOWLEDGE_HEADER)
					expect(out, `surface=${surface} status=${status}`).toContain("## Upfront Contract")
				}
			})
		}

		it("preserves planner rules for draft when ferment-oneshot is set", () => {
			const out = buildFermentPromptBlock(PI_ONESHOT, makeRuntime({ status: "draft" }))
			expect(out).toContain(STATE_MACHINE_HEADER)
			expect(out).toContain(FILE_RULE)
			expect(out).toContain(KNOWLEDGE_HEADER)
			expect(out).toContain(CREATE_GUARD)
		})

		it("tells planners that ferment creation is host-owned", () => {
			const out = buildFermentPromptBlock(PI_NORMAL, makeRuntime({ status: "running" }))
			expect(out).toContain(CREATE_GUARD)
			expect(out).toContain('/ferment new "..."')
			expect(out).toContain("Do not search for, retry with, or invent variants")
			expect(out).toContain("new_ferment")
		})

		it("preserves paused warning for status=paused regardless of ferment-oneshot flag", () => {
			for (const surface of ["normal", "oneshot"] as const) {
				const out = buildFermentPromptBlock(PI_BY_NAME[surface], makeRuntime({ status: "paused" }))
				expect(out, `surface=${surface}`).toContain(PAUSED_HEADER)
				expect(out, `surface=${surface}`).toContain(PAUSED_RULE)
			}
		})

		it("warns against turning fixed interfaces into configurable options", () => {
			const out = buildFermentPromptBlock(PI_ONESHOT, makeRuntime()) ?? ""
			expect(out).toContain("fixed output path")
			expect(out).toContain("fixed runtime interface")
			expect(out).toContain("extra CLI argument")
			expect(out).toContain("config option")
			expect(out).toContain("flexible interface")
		})

		it("includes Upfront Contract directives mentioning propose_ferment_scoping", () => {
			const out = buildFermentPromptBlock(PI_ONESHOT, makeRuntime({}, "automated")) ?? ""
			expect(out).toContain("Upfront Contract")
			expect(out).toContain("do not ask the user to confirm phase advancement")
			expect(out).toContain("propose_ferment_scoping")
			expect(out).toContain("Ask clarifying questions only when the answer is decision-blocking")
			expect(out).toContain('<phase_0_inventory required="true"')
			expect(out).toContain(
				"First response action: print a concise inventory of all available skills and subagent types",
			)
			expect(out).toContain('<discovery_sequence required="true">')
			expect(out).toContain("if skills are not exposed in this environment, say that explicitly")
			expect(out).toContain("recommended: true")
			expect(out).toContain("choose the right style with `type`")
			expect(out).toContain("`radio` for one choice or yes/no")
			expect(out).toContain("`checkbox` for multi-select")
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

		it("guides plan-shaping discovery before proposing scoping", () => {
			const out = buildFermentPromptBlock(PI_ONESHOT, makeRuntime()) ?? ""
			expect(out).toContain("follow the shared discovery guidance in the Upfront Contract")
			expect(out).toContain("For broad improvement/audit/planning requests over an existing codebase")
			expect(out).toContain("Immediately spawn 1-4 narrow Explore subagents")
			expect(out).toContain("One Explore subagent is valid when there is only one broad unknown")
			expect(out).toContain("short entrypoint snippets")
			expect(out).toContain("Do not use unbounded Read calls")
			expect(out).toContain("first get the file's line count or tool-reported length")
			expect(out).toContain("read at most a short snippet, about 60 lines or less")
			expect(out).toContain("Only read an implementation/UI/style file end-to-end")
			expect(out).toContain("If a file is longer than about 120 lines")
			expect(out).toContain("Use direct reads for narrow facts and short snippets only")
			expect(out).toContain("file listing plus concise manifest/README/package/config reads")
			expect(out).toContain('Do not "round out the initial scan"')
			expect(out).toContain("Do not skip this checkpoint just because the direct scan feels sufficient")
			expect(out).toContain("If you accidentally read an entire implementation, UI, or style file")
			expect(out).toContain("stop direct reads immediately")
			expect(out).toContain("Skip only when the task is simple/greenfield")
			expect(out).toContain("record that reason in assumptions")
			expect(out).toContain("Use Explore subagents for broader or parallel discovery")
			expect(out).toContain('subagent_type: "Explore"')
			expect(out).toContain("token_budget: 120000")
			expect(out).toContain("increase only if the user explicitly asks or the missing fact is genuinely plan-blocking")
			expect(out).toContain("run_in_background: true")
			expect(out).toContain("file map/entry points")
			expect(out).toContain("do not retry the same broad task")
			expect(out).toContain("spawn a narrower replacement only if that missing fact is plan-blocking")
			expect(out).toContain("continue with direct targeted reads")
			expect(out).toContain('otherwise become an "explore", "find the existing pattern"')
			expect(out).toContain("The plan you propose should reflect the discovered files")
			expect(out).toContain("all P1/P2/P3 gates")
		})

		it("uses manual phase-boundary instructions under manual continuation policy", () => {
			const out = buildFermentPromptBlock(PI_NORMAL, makeRuntime({}, "manual")) ?? ""
			expect(out).toContain("Manual continuation policy is active")
			expect(out).toContain("ask the user before activating the next phase")
			expect(out).toContain("do not call `activate_ferment_phase` until they say continue")
			expect(out).not.toContain("do not ask the user to confirm phase advancement")
		})

		it("uses automated cross-phase instructions under automated continuation policy", () => {
			const out = buildFermentPromptBlock(PI_NORMAL, makeRuntime({}, "automated")) ?? ""
			expect(out).toContain("Automated continuation policy is active")
			expect(out).toContain("continue across phase boundaries")
			expect(out).toContain("do not ask the user to confirm phase advancement")
		})

		it("lists default subagent types when the registry is populated", () => {
			// registerAgents loads DEFAULT_AGENTS, mirroring session_start in the
			// agents extension.
			registerAgents(new Map())

			const out = buildFermentPromptBlock(PI_ONESHOT, makeRuntime()) ?? ""
			expect(out).toContain("Available subagent types")
			expect(out).toContain("**Explore**")
		})

		it("uses the active ferment name in the planner role line", () => {
			const out = buildFermentPromptBlock(PI_ONESHOT, makeRuntime()) ?? ""
			expect(out).toContain('ferment "Runtime Plan"')
			// Phase-grade-based self-improvement was removed when per-phase grading
			// went away. Corrective-step pipeline now lives in complete_ferment_phase
			// retries — surfaced via tool error text, not via a prompt section.
			expect(out).not.toContain("## Self-Improvement Feedback")
		})

		it("does not prescribe concrete worker models — orchestrator owns that policy now", () => {
			const out = buildFermentPromptBlock(PI_ONESHOT, makeRuntime()) ?? ""
			expect(out).not.toContain("minimax-m2.7")
			expect(out).not.toContain("kimi-k2.5")
			expect(out).not.toContain("worker_model")
		})
	})

	describe("paused isolation — mutual exclusion at runtime", () => {
		const PI_BY_NAME = { normal: PI_NORMAL, oneshot: PI_ONESHOT }

		it("paused renders the warning without planner supplement substrings", () => {
			for (const surface of ["normal", "oneshot"] as const) {
				const out = buildFermentPromptBlock(PI_BY_NAME[surface], makeRuntime({ status: "paused" })) ?? ""
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
					const out = buildFermentPromptBlock(PI_BY_NAME[surface], makeRuntime({ status })) ?? ""
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

			const normalText = buildFermentPromptBlock(PI_NORMAL, runtime) ?? ""
			const oneshotText = buildFermentPromptBlock(PI_ONESHOT, runtime) ?? ""

			for (const sub of PARITY_SUBSTRINGS) {
				expect(normalText, `ferment-oneshot=false missing: ${sub}`).toContain(sub)
				expect(oneshotText, `ferment-oneshot=true missing: ${sub}`).toContain(sub)
			}
		})
	})
})
