/**
 * Step tools: start_ferment_step, complete_ferment_step, verify_ferment_step, skip_ferment_step, fail_ferment_step.
 *
 * complete_ferment_step is the largest — it auto-runs the verification command (with
 * a 60s timeout), routes non-zero exits through the judge for pass/retry/fail
 * classification, then grades the step.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Static } from "typebox"
import type { StepResult } from "../../../ferment/types.js"
import { askUser } from "../ask-user.js"
import { validateFsmTransitionWithFerment } from "../fsm-adapter.js"
import { renderGateGuidance } from "../gate-registry.js"
import { validateGatesOrErr } from "../gate-validation.js"
import { type JudgeVerdict, judgeStepVerification } from "../judge.js"
import { onStepCompleted } from "../nudge.js"
import { type PhaseEvidence, captureGitHead, gatherPhaseEvidence } from "../phase-evidence.js"
import { type FermentRuntime, defaultFermentRuntime } from "../runtime.js"
import {
	createApplyAndPersist,
	failedToolResult,
	resolvePhase,
	resolveStep,
	toolErr,
	toolErrWithNextAction,
	toolOk,
	withNextActionHint,
} from "../tool-helpers.js"
import { CompleteStepParams, FailStepParams, StepActionParams, VerifyParams } from "../tool-schemas.js"
import type { FermentUi, FermentUiContext } from "../ui.js"
import { buildWorkerContext } from "../worker-prompt.js"

const VERIFY_TIMEOUT_MS = 60_000

function sendStepBreadcrumb(pi: ExtensionAPI, text: string, variant: "step" | "warning" = "step"): void {
	void pi.sendMessage(
		{
			customType: "ferment_breadcrumb",
			content: [{ type: "text", text }],
			display: true,
			details: { text, variant },
		},
		{ triggerTurn: false },
	)
}

type StepActionArgs = Static<typeof StepActionParams>
type CompleteStepArgs = Static<typeof CompleteStepParams>

type ToolResult = ReturnType<typeof toolOk> | ReturnType<typeof toolErr>

type StepUiContext = Omit<Partial<FermentUiContext>, "ui"> & { ui?: Partial<FermentUi> }

export interface VerificationExecution {
	command: string
	signal?: AbortSignal
	onUpdate?: unknown
	ctx?: StepUiContext
}

export interface VerificationResult {
	exitCode: number
	stdout: string
	stderr: string
}

export interface StepHandlerServices {
	captureGitHead(): string | undefined
	gatherEvidence(ref: string): PhaseEvidence | undefined
	judgeStepVerification(
		stepDescription: string,
		verificationCommand: string,
		stdout: string,
		stderr: string,
		exitCode: number,
	): Promise<JudgeVerdict>
	onStepCompleted(runtime: FermentRuntime): void
	buildWorkerContext: typeof buildWorkerContext
	runVerification(args: VerificationExecution): Promise<VerificationResult>
}

export interface StepExecutionContext {
	pi: ExtensionAPI
	ctx?: StepUiContext
	signal?: AbortSignal
	onUpdate?: unknown
}

export const defaultStepHandlerServices: StepHandlerServices = {
	captureGitHead,
	gatherEvidence: gatherPhaseEvidence,
	judgeStepVerification,
	onStepCompleted,
	buildWorkerContext,
	runVerification: runVerificationCommand,
}

const validateFsmTransition = (
	f: Parameters<typeof validateFsmTransitionWithFerment>[0],
	event: Parameters<typeof validateFsmTransitionWithFerment>[1],
	params?: Parameters<typeof validateFsmTransitionWithFerment>[2],
): string | null => validateFsmTransitionWithFerment(f, event, params).error ?? null

async function runVerificationCommand({
	command,
	signal,
	onUpdate,
	ctx,
}: VerificationExecution): Promise<VerificationResult> {
	let exitCode = 0
	let stdout = ""
	let stderr = ""
	// biome-ignore lint/suspicious/noExplicitAny: accessing controller tools
	const controller = (ctx as any)?.controller
	if (controller?.tools?.bash?.execute) {
		const verifySignal = signal
			? AbortSignal.any([signal, AbortSignal.timeout(VERIFY_TIMEOUT_MS)])
			: AbortSignal.timeout(VERIFY_TIMEOUT_MS)
		try {
			// biome-ignore lint/suspicious/noExplicitAny: tool execution
			const execResult = await (controller.tools.bash.execute as any)("", { command }, verifySignal, onUpdate, ctx)
			stdout = execResult.stdout ?? ""
			stderr = execResult.stderr ?? ""
			exitCode = execResult.exitCode ?? 0
		} catch (e) {
			exitCode = 1
			stderr =
				e instanceof Error && e.name === "TimeoutError"
					? "Verification command timed out after 60s"
					: "bash execution threw an exception"
		}
	}
	return { exitCode, stdout, stderr }
}

export async function startStep(
	runtime: FermentRuntime,
	params: StepActionArgs,
	{ pi, ctx }: StepExecutionContext,
	services: StepHandlerServices = defaultStepHandlerServices,
): Promise<ToolResult> {
	const applyAndPersist = createApplyAndPersist(runtime)
	const f = runtime.getStorage().get(params.ferment_id)
	if (!f) return toolErr("Ferment not found.")
	const phase = resolvePhase(f, params.phase_id)
	if (!phase) return toolErr("Phase not found.")
	const step = resolveStep(phase, params.step_id)
	if (!step) {
		return toolErr(
			`Step not found. Steps: ${phase.steps.map((st) => `[${st.id}] ${st.index}. ${st.description}`).join(", ")}`,
		)
	}

	const fsmError = validateFsmTransition(f, "START_STEP", { phaseId: phase.id, stepId: step.id })
	if (fsmError) return toolErrWithNextAction(fsmError, f)

	const startCount = runtime.bumpStepStart(f.id, phase.id, step.id)
	if (startCount >= 3) {
		const title = `Step ${step.index}: "${step.description}" has been started ${startCount} times without completing.`
		const response = await askUser(
			title,
			[
				{ id: "retry", label: "Retry" },
				{ id: "skip", label: "Skip step" },
				{ id: "pause", label: "Pause ferment" },
			],
			{ ferment: f, pi, ctx, runtime },
		)

		if (response.failed) {
			// No audience could be reached. Fall back to the headless error.
			return toolErr(
				`⚠ Stuck loop detected: ${title}

What should we do?

1) Retry
2) Skip step
3) Pause ferment

Do NOT call start_ferment_step again without user input.`,
			)
		}

		if (response.choice === "pause") {
			const pauseOutcome = applyAndPersist(f.id, { type: "pause" })
			if (!pauseOutcome.ok) return failedToolResult(pauseOutcome.error)
			return toolOk(withNextActionHint("Ferment paused at user request.", pauseOutcome.ferment))
		}

		if (response.choice === "skip") {
			const skipOutcome = applyAndPersist(f.id, {
				type: "skip_step",
				phaseId: phase.id,
				stepId: step.id,
			})
			if (!skipOutcome.ok) return failedToolResult(skipOutcome.error)
			runtime.clearStepStart(f.id, phase.id, step.id)
			services.onStepCompleted(runtime)
			return toolOk(
				withNextActionHint(`Step ${step.index}: "${step.description}" skipped at user request.`, skipOutcome.ferment),
			)
		}

		// choice === "retry"
		runtime.clearStepStart(f.id, phase.id, step.id)
	}

	const outcome = applyAndPersist(params.ferment_id, {
		type: "start_step",
		phaseId: phase.id,
		stepId: step.id,
	})
	if (!outcome.ok) {
		if (outcome.error.code === "CONCURRENT_NON_PARALLEL_STEP") {
			return toolErrWithNextAction(
				`Cannot start step ${step.index} — step ${outcome.error.runningStepIndex} ("${outcome.error.runningDescription}") is already running and is not parallel-safe. Complete or skip it first.`,
				f,
			)
		}
		return failedToolResult(outcome.error, f)
	}

	const stepHeadRef = services.captureGitHead()
	if (stepHeadRef) runtime.setStepStartRef(params.ferment_id, phase.id, step.id, stepHeadRef)

	const freshPhase = outcome.ferment.phases.find((p) => p.id === phase.id)
	const freshStep = freshPhase?.steps.find((s) => s.id === step.id)

	const prevStep = freshPhase?.steps.find((st) => st.index === step.index - 1)
	const lowGradeCaution =
		prevStep?.grade && ["C", "D", "F"].includes(prevStep.grade.grade)
			? `\n\n⚠️  Previous step (${prevStep.index}: "${prevStep.description}") received grade ${prevStep.grade.grade}: ${prevStep.grade.rationale}. Apply extra scrutiny to this step — verify edge cases, error handling, and completeness before reporting done.`
			: ""

	const parallelSiblings =
		freshStep?.parallel && freshStep.groupIndex !== undefined
			? (freshPhase?.steps ?? [])
					.filter(
						(st) =>
							st.id !== step.id && st.status === "pending" && st.parallel && st.groupIndex === freshStep.groupIndex,
					)
					.map((st) => ({
						step_id: st.id,
						description: st.description,
					}))
			: []

	const parallelNote =
		parallelSiblings.length > 0
			? `\nparallel_siblings: ${JSON.stringify(parallelSiblings)}\n\nThese steps are independent — call start_ferment_step for each one now and launch their Agents concurrently. Do not wait for one to finish before starting the next.`
			: ""

	const workerContext =
		freshPhase && freshStep ? services.buildWorkerContext(outcome.ferment, freshPhase, freshStep) : ""
	const contextBlock = workerContext ? `\n\nWorker context (pass to subagent verbatim):\n${workerContext}` : ""

	return toolOk(
		withNextActionHint(
			`Step ${step.index}: "${step.description}" started. Spawn a subagent with subagent_type "general-purpose". When it returns, call complete_ferment_step with its summary.${lowGradeCaution}${parallelNote}${contextBlock}`,
			outcome.ferment,
		),
	)
}

export async function completeStep(
	runtime: FermentRuntime,
	params: CompleteStepArgs,
	{ pi, ctx, signal, onUpdate }: StepExecutionContext,
	services: StepHandlerServices = defaultStepHandlerServices,
): Promise<ToolResult> {
	const applyAndPersist = createApplyAndPersist(runtime)
	runtime.captureJudgeContext(ctx?.model, ctx?.modelRegistry)

	const f = runtime.getStorage().get(params.ferment_id)
	if (!f) return toolErr("Ferment not found.")
	const phase = resolvePhase(f, params.phase_id)
	if (!phase) return toolErr("Phase not found.")
	const step = resolveStep(phase, params.step_id)
	if (!step) return toolErr("Step not found.")

	const fsmError = validateFsmTransition(f, "COMPLETE_STEP", { phaseId: phase.id, stepId: step.id })
	if (fsmError) return toolErrWithNextAction(fsmError, f)

	// Gate validation runs BEFORE any state mutation. Step-level flags don't
	// feed the phase retry/escalation pipeline — they just refuse this single
	// call, and the agent has to fix the underlying issue and re-call.
	const gateError = validateGatesOrErr(params.gates, {
		turn: "complete_ferment_step",
		flagPolicy: "block-on-flag",
		renderFlagError: (count, lines) =>
			`Step ${step.index}: "${step.description}" cannot complete — agent self-flagged on ${count} step gate(s):\n\n${lines}\n\nResolve the underlying issue and re-call complete_ferment_step with verdicts of 'pass' (or 'omitted' with rationale if a gate truly does not apply).`,
	})
	if (gateError) return gateError

	if (!step.verification) {
		// No verification command — gate verdicts are the only signal. Trust
		// them and advance. Phase-level F1 will catch the case where the
		// whole phase was unverified.
		const completeOutcome = applyAndPersist(params.ferment_id, {
			type: "complete_step",
			phaseId: phase.id,
			stepId: step.id,
			summary: params.summary,
		})
		if (!completeOutcome.ok) return failedToolResult(completeOutcome.error, f)
		runtime.clearStepStart(f.id, phase.id, step.id)
		runtime.bumpStepCompleteAttempt(f.id, phase.id, step.id)
		services.onStepCompleted(runtime)
		sendStepBreadcrumb(pi, `Step ${step.index} ✓ ${step.description}`)
		return toolOk(
			withNextActionHint(
				`Step ${step.index}: "${step.description}" done.  ${params.summary ?? ""}`,
				completeOutcome.ferment,
			),
		)
	}

	const { exitCode, stdout, stderr } = await services.runVerification({
		command: step.verification.command,
		signal,
		onUpdate,
		ctx,
	})
	const verifyResult: StepResult = {
		success: exitCode === 0,
		exitCode,
		stdout,
		stderr,
		completedAt: runtime.nowIso(),
	}

	const verifyOutcome = applyAndPersist(params.ferment_id, {
		type: "verify_step",
		phaseId: phase.id,
		stepId: step.id,
		result: verifyResult,
		summary: params.summary,
	})
	if (!verifyOutcome.ok) return failedToolResult(verifyOutcome.error, f)
	runtime.clearStepStart(f.id, phase.id, step.id)

	if (exitCode === 0) {
		// Verification passed + all gates pass → silent advance. No LLM call.
		runtime.bumpStepCompleteAttempt(f.id, phase.id, step.id)
		services.onStepCompleted(runtime)
		sendStepBreadcrumb(pi, `Step ${step.index} ✓ verified — ${step.description}`)
		return toolOk(
			withNextActionHint(`Step ${step.index}: "${step.description}" done and verified ✓`, verifyOutcome.ferment),
		)
	}

	// Non-zero verify exit. judgeStepVerification is tactical (pass/retry/fail
	// classification of a failed command), not grading — it stays.
	const judgeVerdict = await services.judgeStepVerification(
		step.description,
		step.verification.command,
		stdout,
		stderr,
		exitCode,
	)

	if (judgeVerdict.verdict === "pass") {
		// Tactical pass: command exited non-zero but the judge says the work
		// is acceptable (e.g. linter noise on an unrelated file). Gate
		// verdicts already passed above, so advance.
		runtime.bumpStepCompleteAttempt(f.id, phase.id, step.id)
		services.onStepCompleted(runtime)
		sendStepBreadcrumb(pi, `Step ${step.index} ✓  Judge passed: ${judgeVerdict.reason}`)
		return toolOk(
			withNextActionHint(
				`Step ${step.index}: "${step.description}" done ✓  Judge: ${judgeVerdict.reason}`,
				verifyOutcome.ferment,
			),
		)
	}

	const failOutcome = applyAndPersist(params.ferment_id, {
		type: "fail_step",
		phaseId: phase.id,
		stepId: step.id,
		error: `Verification failed (exit ${exitCode}): ${judgeVerdict.reason}`,
	})
	if (!failOutcome.ok) return failedToolResult(failOutcome.error, f)

	sendStepBreadcrumb(pi, `Step ${step.index} ✗ failed verification — ${judgeVerdict.reason}`, "warning")

	// D19: surface a recovery dropdown so the user picks an action explicitly
	// instead of leaving the planner guessing.
	if (ctx?.ui?.select) {
		const retryLabel = "Retry"
		const skipLabel = "Skip step"
		const editLabel = "Edit prompt and retry"
		const abandonLabel = "Abandon phase"
		const cancelLabel = "Cancel (keep step failed)"
		const title = `Step ${step.index} "${step.description}" failed verification.\nJudge: ${judgeVerdict.reason}`
		const choice = await ctx.ui.select(title, [retryLabel, skipLabel, editLabel, abandonLabel, cancelLabel])
		runtime.markHumanInput()

		if (choice === retryLabel) {
			const retryOut = applyAndPersist(params.ferment_id, {
				type: "start_step",
				phaseId: phase.id,
				stepId: step.id,
			})
			if (!retryOut.ok) return failedToolResult(retryOut.error)
			runtime.clearStepStart(f.id, phase.id, step.id)
			return toolOk(
				`Step ${step.index} reset to running at user request. Retry the work — spawn a worker and call complete_step when done.`,
			)
		}

		if (choice === skipLabel) {
			const skipOut = applyAndPersist(params.ferment_id, {
				type: "skip_step",
				phaseId: phase.id,
				stepId: step.id,
			})
			if (!skipOut.ok) return failedToolResult(skipOut.error)
			services.onStepCompleted(runtime)
			return toolOk(`Step ${step.index} skipped at user request.`)
		}

		if (choice === editLabel && ctx.ui.input) {
			const newPrompt = await ctx.ui.input("Revised step description:", step.description)
			runtime.markHumanInput()
			if (newPrompt?.trim()) {
				const editOut = applyAndPersist(params.ferment_id, {
					type: "update_step_description",
					phaseId: phase.id,
					stepId: step.id,
					description: newPrompt.trim(),
				})
				if (!editOut.ok) return failedToolResult(editOut.error)
				const retryOut = applyAndPersist(params.ferment_id, {
					type: "start_step",
					phaseId: phase.id,
					stepId: step.id,
				})
				if (!retryOut.ok) return failedToolResult(retryOut.error)
				runtime.clearStepStart(f.id, phase.id, step.id)
				await pi.sendUserMessage(`Retry step ${step.index} with this revised approach: ${newPrompt.trim()}`, {
					deliverAs: "followUp",
				})
				return toolOk(`Step ${step.index} reset with revised approach. Awaiting planner re-execution.`)
			}
			return toolOk(`Step ${step.index} remains failed (no revised approach provided).`)
		}

		if (choice === abandonLabel) {
			const phaseFailOut = applyAndPersist(params.ferment_id, {
				type: "fail_phase",
				phaseId: phase.id,
				reason: `Step ${step.index} failed: ${judgeVerdict.reason}`,
			})
			if (!phaseFailOut.ok) return failedToolResult(phaseFailOut.error)
			return toolOk(`Phase ${phase.index} marked failed at user request after step ${step.index} verification failure.`)
		}

		// Cancel, Esc/dismiss, or any unrecognised choice → no-op. The step is
		// already in failed state from the fail_step above; preserve the phase
		// and let the planner decide the next move.
		return toolOk(
			`Step ${step.index} remains failed. User dismissed the recovery dropdown without choosing an action — phase preserved.`,
		)
	}

	if (judgeVerdict.verdict === "retry") {
		return toolErr(
			`Step ${step.index} verification failed — retry suggested.\nExit: ${exitCode}\nJudge: ${judgeVerdict.reason}\nstdout: ${stdout.slice(0, 500)}\nstderr: ${stderr.slice(0, 500)}`,
		)
	}
	return toolErr(
		`Step ${step.index} failed verification.\nExit: ${exitCode}\nJudge: ${judgeVerdict.reason}\nstdout: ${stdout.slice(0, 500)}\nstderr: ${stderr.slice(0, 500)}`,
	)
}

export function registerStepTools(pi: ExtensionAPI, runtime: FermentRuntime = defaultFermentRuntime): void {
	const applyAndPersist = createApplyAndPersist(runtime)
	const stepServices: StepHandlerServices = {
		...defaultStepHandlerServices,
		onStepCompleted: () => onStepCompleted(runtime),
	}
	pi.registerTool({
		name: "start_ferment_step",
		label: "Start Step",
		description:
			"Mark a step as running. Returns parallel_siblings. See planner instructions in the system prompt for orchestration details.",
		parameters: StepActionParams,
		async execute(_, params, _signal, _onUpdate, ctx) {
			return startStep(runtime, params, { pi, ctx }, stepServices)
		},
	})

	pi.registerTool({
		name: "complete_ferment_step",
		label: "Complete Step",
		description: `Mark step as done. If the step has a verification command it runs automatically — no need to call verify_ferment_step separately. You must produce verdicts for the three step-scope gates below. A "flag" verdict blocks step completion.

${renderGateGuidance("complete_ferment_step")}`,
		parameters: CompleteStepParams,
		async execute(_, params, signal, onUpdate, ctx) {
			return completeStep(runtime, params, { pi, ctx, signal, onUpdate }, stepServices)
		},
	})

	pi.registerTool({
		name: "verify_ferment_step",
		label: "Verify Step",
		description: "Run verification command and record result.",
		parameters: VerifyParams,
		async execute(_, params, signal, onUpdate, ctx) {
			const f = runtime.getStorage().get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")
			const phase = resolvePhase(f, params.phase_id)
			if (!phase) return toolErr("Phase not found.")
			const step = resolveStep(phase, params.step_id)
			if (!step) return toolErr("Step not found.")

			// FSM validation: ensure step verification is allowed
			const fsmError = validateFsmTransition(f, "VERIFY_STEP", { phaseId: phase.id, stepId: step.id })
			if (fsmError) return toolErrWithNextAction(fsmError, f)

			let exitCode = 0
			let stdout = ""
			let stderr = ""

			// biome-ignore lint/suspicious/noExplicitAny: accessing controller tools
			const controller = (ctx as any).controller
			if (controller?.tools?.bash?.execute) {
				const verifySignal = signal
					? AbortSignal.any([signal, AbortSignal.timeout(VERIFY_TIMEOUT_MS)])
					: AbortSignal.timeout(VERIFY_TIMEOUT_MS)
				try {
					// biome-ignore lint/suspicious/noExplicitAny: tool execution
					const execResult = await (controller.tools.bash.execute as any)(
						"",
						{ command: params.command },
						verifySignal,
						onUpdate,
						ctx,
					)
					stdout = execResult.stdout ?? ""
					stderr = execResult.stderr ?? ""
					exitCode = execResult.exitCode ?? 0
				} catch {
					exitCode = 1
				}
			} else {
				stdout = params.command
			}

			const result: StepResult = {
				success: exitCode === 0,
				exitCode,
				stdout,
				stderr,
				completedAt: runtime.nowIso(),
			}

			const outcome = applyAndPersist(params.ferment_id, {
				type: "verify_step",
				phaseId: phase.id,
				stepId: step.id,
				result,
				summary: params.summary,
			})
			if (!outcome.ok) return failedToolResult(outcome.error, f)
			onStepCompleted(runtime)

			if (result.success) return toolOk(withNextActionHint(`✓ "${step.description}" verified.`, outcome.ferment))
			return toolErrWithNextAction(`✗ "${step.description}" failed (exit ${exitCode}).`, outcome.ferment)
		},
	})

	pi.registerTool({
		name: "skip_ferment_step",
		label: "Skip Step",
		description: "Skip a step.",
		parameters: StepActionParams,
		async execute(_, params) {
			const f = runtime.getStorage().get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")
			const phase = resolvePhase(f, params.phase_id)
			if (!phase) return toolErr("Phase not found.")
			const step = resolveStep(phase, params.step_id)
			if (!step) return toolErr("Step not found.")

			// FSM validation: ensure step skip is allowed
			const fsmError = validateFsmTransition(f, "SKIP_STEP", { phaseId: phase.id, stepId: step.id })
			if (fsmError) return toolErrWithNextAction(fsmError, f)

			const outcome = applyAndPersist(params.ferment_id, {
				type: "skip_step",
				phaseId: phase.id,
				stepId: step.id,
			})
			if (!outcome.ok) return failedToolResult(outcome.error, f)
			runtime.clearStepStart(f.id, phase.id, step.id)
			onStepCompleted(runtime)
			return toolOk(withNextActionHint("Step skipped.", outcome.ferment))
		},
	})

	pi.registerTool({
		name: "fail_ferment_step",
		label: "Fail Step",
		description: "Mark a step as failed with an error message.",
		parameters: FailStepParams,
		async execute(_, params) {
			const f = runtime.getStorage().get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")
			const phase = resolvePhase(f, params.phase_id)
			if (!phase) return toolErr("Phase not found.")
			const step = resolveStep(phase, params.step_id)
			if (!step) return toolErr("Step not found.")

			// FSM validation: ensure step fail is allowed
			const fsmError = validateFsmTransition(f, "FAIL_STEP", { phaseId: phase.id, stepId: step.id })
			if (fsmError) return toolErrWithNextAction(fsmError, f)

			const outcome = applyAndPersist(params.ferment_id, {
				type: "fail_step",
				phaseId: phase.id,
				stepId: step.id,
				error: params.error,
			})
			if (!outcome.ok) return failedToolResult(outcome.error, f)
			onStepCompleted(runtime)
			return toolOk(
				withNextActionHint(
					`Step ${step.index}: "${step.description}" marked as failed. Use skip_ferment_step to skip it, or retry the work and call start_ferment_step again.`,
					outcome.ferment,
				),
			)
		},
	})
}
