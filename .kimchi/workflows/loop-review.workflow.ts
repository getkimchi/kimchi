import { createAgentStep, createStep, createWorkflow, type RunContext } from "@kimchi-dev/kimchi-workflows"
import { type Static, Type } from "typebox"

export const GLM_MODEL = "kimchi-dev/glm-5.2-fp8"
export const KIMI_MODEL = "kimchi-dev/kimi-k2.7"
export const MAX_REVIEW_ROUNDS = 5

const REVIEW_LOOP_NODE = "review-cycles"

const prioritySchema = Type.Union([Type.Literal("P0"), Type.Literal("P1"), Type.Literal("P2"), Type.Literal("P3")])

export const intentBriefSchema = Type.Object({
	baseRef: Type.String({ description: "The locally available branch or ref this change is intended to merge into." }),
	summary: Type.String({ description: "A concise statement of the confirmed change intent." }),
	problem: Type.String({ description: "The developer or user problem the change is intended to solve." }),
	expectedBehavior: Type.Array(Type.String()),
	acceptanceCriteria: Type.Array(Type.String()),
	constraints: Type.Array(Type.String()),
	nonGoals: Type.Array(Type.String()),
	evidence: Type.Array(Type.String()),
	uncertainties: Type.Array(Type.String()),
})

export const reviewFindingSchema = Type.Object({
	title: Type.String(),
	priority: prioritySchema,
	category: Type.Union([
		Type.Literal("correctness"),
		Type.Literal("edge-case"),
		Type.Literal("convention"),
		Type.Literal("design"),
		Type.Literal("complexity"),
		Type.Literal("language-idiom"),
		Type.Literal("tests"),
	]),
	file: Type.String({ description: "Repository-relative path containing the issue." }),
	line: Type.Optional(Type.Integer({ minimum: 1 })),
	problem: Type.String(),
	impact: Type.String(),
	evidence: Type.String(),
	recommendation: Type.String(),
})

const reviewContextSchema = Type.Object({
	intent: intentBriefSchema,
	round: Type.Integer({ minimum: 1, maximum: MAX_REVIEW_ROUNDS }),
})

const reviewerResultSchema = Type.Object({
	summary: Type.String(),
	findings: Type.Array(reviewFindingSchema),
	questions: Type.Array(Type.String()),
})

const independentReviewsSchema = Type.Object({
	"review-with-glm": reviewerResultSchema,
	"review-with-kimi": reviewerResultSchema,
})

export const synthesisSchema = Type.Object({
	status: Type.Union([Type.Literal("clean"), Type.Literal("actionable")]),
	message: Type.String({ description: "A clear implementer-ready summary of the current issues." }),
	findings: Type.Array(reviewFindingSchema),
	openQuestions: Type.Array(Type.String()),
})

export const roundResultSchema = Type.Object({
	status: Type.Union([Type.Literal("clean"), Type.Literal("actionable")]),
	message: Type.String(),
	findings: Type.Array(reviewFindingSchema),
	openQuestions: Type.Array(Type.String()),
	round: Type.Integer({ minimum: 1, maximum: MAX_REVIEW_ROUNDS }),
	termination: Type.Union([Type.Literal("continue"), Type.Literal("clean"), Type.Literal("max-iterations")]),
})

export const finalResultSchema = Type.Object({
	outcome: Type.Union([Type.Literal("clean"), Type.Literal("iteration-cap")]),
	rounds: Type.Integer({ minimum: 1, maximum: MAX_REVIEW_ROUNDS }),
	message: Type.String(),
	lastReviewMessage: Type.String(),
	lastReviewedFindings: Type.Array(reviewFindingSchema),
})

type IntentBrief = Static<typeof intentBriefSchema>
type Synthesis = Static<typeof synthesisSchema>
type RoundResult = Static<typeof roundResultSchema>
type FinalResult = Static<typeof finalResultSchema>

const discoverAndConfirmIntent = createAgentStep({
	name: "discover-and-confirm-intent",
	description: "Reconstruct the current branch's intent and obtain explicit user confirmation",
	model: GLM_MODEL,
	output: intentBriefSchema,
	asks: true,
	prompt: () => `Reconstruct and confirm the intent of the change in the current Git repository.

Act only as an intent investigator. Do not review code quality yet, edit files, fetch remotes, switch branches,
create worktrees, or run destructive commands. Read all applicable repository instructions first. Inspect the
current branch, its likely merge target, status, commits, diff, surrounding code, tests, documentation, and local
history. Include committed changes plus staged, unstaged, and relevant untracked working-tree changes. Infer:
- the problem the developer is solving;
- expected user-visible or system behavior;
- concrete acceptance criteria;
- constraints and non-goals;
- the locally available base ref that defines the review comparison; and
- genuine uncertainties that the repository evidence cannot settle.

You MUST obtain explicit user confirmation before submitting the intent brief. First call
workflow_submit_questions with one single-choice question. Put the complete inferred intent in the question text
and offer "Confirm and start review" and "Needs correction". If the user chooses correction, ask a focused free-form
question for missing context or hints, revise the brief, present the complete revised brief, and ask for confirmation
again. Repeat as needed. Do not treat silence, partial agreement, or your own confidence as confirmation. Only after
the user explicitly confirms may you submit the structured intent brief. Preserve user-supplied context even when it
is not recoverable from Git evidence.`,
})

const reviewWithGlm = createAgentStep({
	name: "review-with-glm",
	description: "Review project fit, design clarity, conventions, and language idioms",
	model: GLM_MODEL,
	input: reviewContextSchema,
	output: reviewerResultSchema,
	prompt: ({ input }) =>
		reviewPrompt(
			input,
			`Give special attention to project conventions, API and module design,
language idioms, accidental complexity, unclear ownership, error handling, and tests that fail to demonstrate the
confirmed behavior. Trace realistic behavior as well; this specialization is not permission to ignore functional
bugs or edge cases.`,
		),
})

const reviewWithKimi = createAgentStep({
	name: "review-with-kimi",
	description: "Review functional correctness, edge cases, regressions, and change-specific risks",
	model: KIMI_MODEL,
	input: reviewContextSchema,
	output: reviewerResultSchema,
	prompt: ({ input }) =>
		reviewPrompt(
			input,
			`Give special attention to functional correctness, state transitions,
missed edge cases, regressions, compatibility, failure paths, and risks activated by this particular change. Check
whether the implementation actually satisfies each confirmed acceptance criterion. Also report concrete convention,
design, complexity, or language-idiom problems when they materially affect correctness or maintainability.`,
		),
})

const synthesizeFindings = createAgentStep({
	name: "synthesize-findings",
	description: "Validate and consolidate both reviews into one actionable correction brief",
	model: GLM_MODEL,
	input: independentReviewsSchema,
	output: synthesisSchema,
	prompt: ({ input, ctx }) => {
		const intent = requiredStepResult<IntentBrief>(
			ctx.getStepResult("discover-and-confirm-intent"),
			"discover-and-confirm-intent",
		)
		const round = reviewRoundNumber(ctx)
		return `Synthesize review round ${round} into one pragmatic correction brief.

CONFIRMED INTENT:
${JSON.stringify(intent, null, 2)}

CANDIDATE REVIEWS:
${JSON.stringify(input, null, 2)}

Act as the adjudicating reviewer. You may inspect the current repository, diff, and cited files to validate claims,
but do not edit anything. Re-open every cited location before retaining a finding. Merge duplicates and discard
preferences, speculative risks, stale observations, unrelated pre-existing problems, and changes whose value is too
small to justify implementation. Retain only findings that are concrete, actionable, caused or exposed by the
reviewed change, and likely to improve correctness or maintainability.

Use priorities consistently:
- P0: catastrophic or broadly unsafe behavior that must block merging.
- P1: a credible path breaks core behavior, security, or data integrity.
- P2: a real defect or missed requirement with bounded impact.
- P3: a concrete low-risk convention, design, complexity, idiom, or test problem worth fixing now.

Set status to "clean" only when the final findings array is empty; otherwise set it to "actionable". The message must
be a concise, standalone handoff to the implementer: explain the current issues in priority order, where they occur,
why they matter, and what successful correction looks like. Put unresolved but non-actionable matters in
openQuestions rather than inflating them into findings.`
	},
})

const implementCorrections = createAgentStep({
	name: "implement-corrections",
	description: "Apply the synthesized corrections to the current working tree",
	model: GLM_MODEL,
	input: synthesisSchema,
	prompt: ({ input, ctx }) => {
		const intent = requiredStepResult<IntentBrief>(
			ctx.getStepResult("discover-and-confirm-intent"),
			"discover-and-confirm-intent",
		)
		return `Implement the current code-review corrections in the current working tree.

CONFIRMED INTENT:
${JSON.stringify(intent, null, 2)}

CURRENT ISSUES:
${input.message}

STRUCTURED FINDINGS:
${JSON.stringify(input.findings, null, 2)}

Act as the implementer, not another reviewer. Read all applicable repository instructions before editing. Inspect the
current files because earlier rounds may already have changed them. Preserve unrelated user changes; never reset,
stash, revert, clean, switch branches, or commit. Resolve every finding that still applies with the smallest coherent
change, following the repository's established patterns and language idioms. Add or update focused tests for behavior
changes and run the relevant validation commands. If a cited claim is stale or demonstrably invalid, leave correct
code intact—the next independent review round is the final judge.`
	},
})

const keepCleanResult = createStep({
	name: "keep-clean-result",
	description: "Skip implementation when synthesis found no actionable issues",
	input: synthesisSchema,
	output: synthesisSchema,
	run: ({ input }) => input,
})

const applyCorrections = createWorkflow({ name: "apply-corrections", input: synthesisSchema })
	.then(implementCorrections)
	.commit()

const acceptCleanReview = createWorkflow({ name: "accept-clean-review", input: synthesisSchema })
	.then(keepCleanResult)
	.commit()

const finishReviewRound = createStep({
	name: "finish-review-round",
	description: "Record whether the review should stop, continue, or end at the cap",
	output: roundResultSchema,
	run: ({ ctx }) => {
		const synthesis = requiredStepResult<Synthesis>(ctx.getStepResult("synthesize-findings"), "synthesize-findings")
		const round = reviewRoundNumber(ctx)
		const termination: RoundResult["termination"] =
			synthesis.status === "clean" ? "clean" : round >= MAX_REVIEW_ROUNDS ? "max-iterations" : "continue"
		return { ...synthesis, round, termination }
	},
})

const reviewRound = createWorkflow({ name: "review-round" })
	.map(
		(ctx) => ({
			intent: requiredStepResult<IntentBrief>(
				ctx.getStepResult("discover-and-confirm-intent"),
				"discover-and-confirm-intent",
			),
			round: reviewRoundNumber(ctx),
		}),
		{ name: "assemble-review-context" },
	)
	.parallel([reviewWithGlm, reviewWithKimi], { name: "independent-reviews" })
	.then(synthesizeFindings)
	.branch(
		[
			[
				(ctx) =>
					requiredStepResult<Synthesis>(ctx.getStepResult("synthesize-findings"), "synthesize-findings").status ===
					"actionable",
				applyCorrections,
			],
			[
				(ctx) =>
					requiredStepResult<Synthesis>(ctx.getStepResult("synthesize-findings"), "synthesize-findings").status ===
					"clean",
				acceptCleanReview,
			],
		],
		{ name: "route-synthesis" },
	)
	.then(finishReviewRound)
	.commit()

const finalizeReview = createStep({
	name: "finalize-review",
	description: "Return a clear clean-or-capped workflow result",
	input: roundResultSchema,
	output: finalResultSchema,
	run: ({ input }): FinalResult => {
		if (input.termination === "continue") throw new Error("loop-review finalized before reaching a stop condition")
		if (input.termination === "clean") {
			return {
				outcome: "clean",
				rounds: input.round,
				message: `Review completed cleanly after ${input.round} round${input.round === 1 ? "" : "s"}.`,
				lastReviewMessage: input.message,
				lastReviewedFindings: input.findings,
			}
		}
		return {
			outcome: "iteration-cap",
			rounds: input.round,
			message: `Review stopped after ${MAX_REVIEW_ROUNDS} rounds. The final corrections were implemented but were not reviewed a sixth time.`,
			lastReviewMessage: input.message,
			lastReviewedFindings: input.findings,
		}
	},
})

const loopReviewWorkflow = createWorkflow({
	name: "loop-review",
	description: "Confirm branch intent, review with GLM and Kimi, and let GLM fix findings for up to five rounds",
	maxConcurrency: 2,
})
	.then(discoverAndConfirmIntent)
	.dountil(reviewRound, (_ctx, lastOutput) => isTerminalRound(lastOutput), {
		name: REVIEW_LOOP_NODE,
		maxIterations: MAX_REVIEW_ROUNDS,
	})
	.then(finalizeReview)
	.commit()

export default loopReviewWorkflow

function reviewPrompt(input: Static<typeof reviewContextSchema>, focus: string): string {
	return `Perform independent code review round ${input.round} of the current branch and working tree.

CONFIRMED INTENT:
${JSON.stringify(input.intent, null, 2)}

${focus}

Read all applicable repository instructions first. Review the complete change from the merge base of
${input.intent.baseRef} through HEAD, plus staged, unstaged, and relevant untracked working-tree changes. Inspect
surrounding code and tests needed to understand behavior. This is a read-only parallel review: do not edit files,
install dependencies, fetch, switch branches, create worktrees, or run commands that can modify shared state.

Be pragmatic. Report only issues with a realistic trigger, concrete impact, specific evidence, and an implementable
recommendation. Do not report personal style preferences, speculative hardening, unrelated pre-existing defects, or
concerns already resolved in the current working tree. Use exact repository-relative files and the best available line
locations. Return an empty findings array when there is nothing worth changing before merge.`
}

function requiredStepResult<T>(value: T | undefined, stepName: string): T {
	if (value === undefined) throw new Error(`${stepName} did not produce a result`)
	return value
}

function reviewRoundNumber(ctx: RunContext): number {
	const round = ctx.scope(REVIEW_LOOP_NODE)?.iteration
	if (round === undefined) throw new Error(`${REVIEW_LOOP_NODE} did not provide an iteration number`)
	return round
}

function isTerminalRound(value: unknown): value is RoundResult {
	return (
		typeof value === "object" &&
		value !== null &&
		"termination" in value &&
		(value.termination === "clean" || value.termination === "max-iterations")
	)
}
