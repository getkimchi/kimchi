/**
 * TypeBox parameter schemas for ferment tools.
 *
 * Centralized to keep tool implementations focused on logic. The descriptions
 * here are the LLM-visible API contract — keep them concise and accurate.
 */

import { Type } from "typebox"

/** Structured quality-gate verdict the agent must produce on every completion
 *  tool call. The set of valid `id`s, and which set is required for which
 *  tool, is enforced by `gate-registry.ts:assertGateCoverage`. Description
 *  text rendered into each tool's description tells the agent exactly which
 *  ids to produce and what each one asks. */
export const GateVerdictSchema = Type.Object({
	id: Type.String({
		description: "Gate id from the registry. See the tool description for the exact ids this tool requires.",
	}),
	verdict: Type.Union([Type.Literal("pass"), Type.Literal("flag"), Type.Literal("omitted")], {
		description:
			"'pass' = the gate's question is answered affirmatively with concrete evidence. 'flag' = the gate identifies a real problem (blocks advancement). 'omitted' = the gate doesn't apply to this work (requires rationale).",
	}),
	rationale: Type.String({
		description: "One sentence justifying the verdict. Required for every verdict including 'pass' and 'omitted'.",
	}),
	evidence: Type.String({
		description: "File:line, quoted diff line, command output, or 'n/a' for omitted gates. Empty evidence is rejected.",
	}),
})

export const CreateFermentParams = Type.Object({
	name: Type.String(),
	description: Type.Optional(Type.String()),
})

export const ListParams = Type.Object({
	filter: Type.Optional(Type.String({ description: "Optional status filter" })),
})

// Shared phase schema — used by both scope_ferment (the legacy/headless path)
// and propose_phases (the new interactive path). Keep them identical so a
// proposed plan can be applied verbatim.
const PhaseProposalSchema = Type.Object({
	name: Type.String(),
	goal: Type.String(),
	description: Type.Optional(Type.String()),
	constraints: Type.Optional(Type.Array(Type.String())),
	budget: Type.Optional(Type.String({ description: "e.g. '200k tokens'" })),
	parallel_group: Type.Optional(
		Type.Number({
			description:
				"Phases with the same parallel_group integer run CONCURRENTLY. Use for phases whose outputs are not consumed by their siblings: independent surveys, codebase mapping over disjoint subtrees, parallel audits. Good fit: three 'survey X' phases → all get parallel_group: 1. BAD fit (keep sequential, omit parallel_group): 'Survey files' → 'Edit those files' → 'Verify edits' is a pipeline — each phase consumes the previous phase's output. Same rule as steps: pipelines stay sequential, only independent siblings get the same parallel_group. Singleton groups auto-collapse.",
		}),
	),
	steps: Type.Optional(
		Type.Array(
			Type.Object({
				description: Type.String(),
				verify: Type.Optional(Type.String({ description: "bash command that exits 0 on success" })),
				parallel_group: Type.Optional(
					Type.Number({
						description:
							"Steps with the same parallel_group number run concurrently within the phase. Omit (or use unique values) for sequential steps. A group with only one step is treated as sequential.",
					}),
				),
			}),
			{ description: "Initial step breakdown for this phase. Can be refined later with refine_phase." },
		),
	),
})

export const ScopeParams = Type.Object({
	ferment_id: Type.String(),
	title: Type.Optional(Type.String({ description: "A short 3-5 word title for this ferment" })),
	goal: Type.String(),
	success_criteria: Type.Optional(Type.String()),
	constraints: Type.Optional(Type.Array(Type.String())),
	phases: Type.Optional(Type.Array(PhaseProposalSchema)),
	gates: Type.Array(GateVerdictSchema, {
		description:
			"Plan-scope gate verdicts. Required ids: P1, P2, P3. See tool description for each gate's question and what counts as 'pass' vs 'flag'.",
	}),
})

export const ProposePhasesParams = Type.Object({
	ferment_id: Type.String({
		description:
			"The ferment whose plan you're proposing. Must match the ferment_id given to you in the scoping prompt.",
	}),
	phases: Type.Array(PhaseProposalSchema, {
		description:
			"3–7 ordered phases that will become the project plan. Each phase needs a name, one-sentence goal, and 3–6 concrete step descriptions. The host will save these verbatim when the user confirms via the dropdown.",
	}),
	gates: Type.Array(GateVerdictSchema, {
		description:
			"Plan-scope gate verdicts. Required ids: P1 (verifiable success signal per phase), P2 (phase ordering composes), P3 (success criteria for complete_ferment). See tool description for each gate's question and guidance.",
	}),
})

export const ActivateParams = Type.Object({
	ferment_id: Type.String(),
	phase_id: Type.Optional(
		Type.String({
			description: "Phase ID in format 'phase-N', e.g. 'phase-1'. Use the phase_id returned by scope_ferment.",
		}),
	),
})

export const RefineParams = Type.Object({
	ferment_id: Type.String(),
	phase_id: Type.String({
		description: "Phase ID in format 'phase-N', e.g. 'phase-1'. Use the phase_id returned by activate_phase.",
	}),
	steps: Type.Array(
		Type.Object({
			description: Type.String(),
			verify: Type.Optional(
				Type.String({ description: "Bash command that exits 0 on success. Run automatically after complete_step." }),
			),
			needs_vision: Type.Optional(
				Type.Boolean({
					description:
						"Set true if this step requires processing images or screenshots. Selects kimi-k2.5 as worker; otherwise minimax-m2.7 is used.",
				}),
			),
			parallel_group: Type.Optional(
				Type.Number({
					description:
						"Steps with the same parallel_group integer run CONCURRENTLY inside this phase. Use for steps that read/write disjoint files and don't consume each other's output. Good fit: 'edit package A' + 'edit package B' (both get parallel_group: 1), or one step per file when the user says edits are independent. BAD fit (keep sequential, omit parallel_group): 'find files' → 'record paths' → 'note locations' is a pipeline where each step builds on the previous. Singleton groups auto-collapse to sequential.",
				}),
			),
		}),
	),
})

export const StepActionParams = Type.Object({
	ferment_id: Type.String(),
	phase_id: Type.String({ description: "Phase ID in format 'phase-N', e.g. 'phase-1'." }),
	step_id: Type.String({
		description:
			"Step ID in format 'step-N', e.g. 'step-1'. Use the step_id returned by refine_phase or activate_phase.",
	}),
})

export const CompleteStepParams = Type.Object({
	ferment_id: Type.String(),
	phase_id: Type.String(),
	step_id: Type.String(),
	summary: Type.Optional(Type.String()),
	gates: Type.Array(GateVerdictSchema, {
		description:
			"Step-scope gate verdicts. Required ids: S1 (summary matches diff), S2 (verify command honesty), S3 (edge case awareness). A 'flag' verdict blocks step completion.",
	}),
})

export const VerifyParams = Type.Object({
	ferment_id: Type.String(),
	phase_id: Type.String(),
	step_id: Type.String(),
	command: Type.String(),
	/** Optional worker-written summary of what was accomplished. Persisted on
	 *  Step.summary so subsequent steps in the same phase can reference it via
	 *  the worker-context block. Symmetric with CompleteStepParams.summary. */
	summary: Type.Optional(Type.String()),
})

export const CompletePhaseParams = Type.Object({
	ferment_id: Type.String(),
	phase_id: Type.String(),
	summary: Type.String(),
	gates: Type.Array(GateVerdictSchema, {
		description:
			"Phase-scope gate verdicts. Required ids: F1 (real verification vs proxies), F2 (combined output meets phase goal), F3 (what was deferred). A 'flag' verdict refuses phase advancement and feeds the retry/escalation pipeline.",
	}),
})

export const SkipPhaseParams = Type.Object({
	ferment_id: Type.String(),
	phase_id: Type.String(),
	reason: Type.Optional(Type.String()),
})

export const CompleteFermentParams = Type.Object({
	ferment_id: Type.String(),
	final_summary: Type.Optional(Type.String()),
	gates: Type.Array(GateVerdictSchema, {
		description:
			"Ferment-scope gate verdicts. Required ids: C1 (every plan success criterion satisfied with evidence), C2 (no unresolved F3 deferrals), C3 (real verification actually executed the artifact). A 'flag' verdict refuses ship.",
	}),
})

export const DecisionParams = Type.Object({
	ferment_id: Type.String(),
	title: Type.String(),
	description: Type.String(),
	phase_id: Type.Optional(Type.String()),
	step_id: Type.Optional(Type.String()),
})

export const MemoryParams = Type.Object({
	ferment_id: Type.String(),
	category: Type.String(),
	content: Type.String(),
	phase_id: Type.Optional(Type.String()),
	step_id: Type.Optional(Type.String()),
})

export const ShowParams = Type.Object({ ferment_id: Type.String() })

export const SetModeParams = Type.Object({
	ferment_id: Type.String(),
	mode: Type.String({ description: "plan | exec | auto" }),
})

export const FailStepParams = Type.Object({
	ferment_id: Type.String(),
	phase_id: Type.String(),
	step_id: Type.String(),
	error: Type.Optional(Type.String({ description: "Error message or reason for failure" })),
})

export const FailPhaseParams = Type.Object({
	ferment_id: Type.String(),
	phase_id: Type.String(),
	reason: Type.String({ description: "Why the phase failed" }),
})

export const UpdateScopeFieldParams = Type.Object({
	ferment_id: Type.String(),
	field: Type.String({ description: "goal | criteria | constraints" }),
	value: Type.String({ description: "New value. For constraints, use comma-separated list." }),
})

/** Option offered to the user (or the judge standing in for the user in
 *  one-shot mode) by the `ask_user` tool. */
const AskUserOptionSchema = Type.Object({
	id: Type.String({ description: "Stable identifier returned in the response. Pick short snake-case ids." }),
	label: Type.String({ description: "Human-readable label shown in the TUI." }),
	description: Type.Optional(
		Type.String({
			description: "Optional short context shown beneath the label and given to the judge in one-shot mode.",
		}),
	),
})

export const AskUserParams = Type.Object({
	ferment_id: Type.String(),
	question: Type.String({
		description:
			"The decision the agent cannot resolve from context alone. Be concrete and self-contained — the user (or the judge standing in for the user in one-shot mode) sees only this text plus the options.",
	}),
	options: Type.Array(AskUserOptionSchema, {
		description:
			"2–5 options. Each option needs a stable id and a human label. Include 'pause' or 'abandon' as an explicit option when relevant — the judge prefers these when uncertain.",
	}),
})
