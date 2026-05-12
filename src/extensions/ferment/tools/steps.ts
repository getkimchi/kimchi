/**
 * Step tools: start_step, complete_step, verify_step, skip_step, fail_step.
 *
 * complete_step is the largest — it auto-runs the verification command (with
 * a 60s timeout), routes non-zero exits through the judge for pass/retry/fail
 * classification, then grades the step.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Static } from "typebox"
import type { JudgeGrade, StepResult } from "../../../ferment/types.js"
import { validateFsmTransitionWithFerment } from "../fsm-adapter.js"
import { type JudgeVerdict, judgeGradeStep, judgeStepVerification } from "../judge.js"
import { onStepCompleted } from "../nudge.js"
import { type PhaseEvidence, captureGitHead, gatherPhaseEvidence } from "../phase-evidence.js"
import { type FermentRuntime, defaultFermentRuntime } from "../runtime.js"
import { createApplyAndPersist, failedToolResult, resolvePhase, resolveStep, toolErr, toolOk } from "../tool-helpers.js"
import { CompleteStepParams, FailStepParams, StepActionParams, VerifyParams } from "../tool-schemas.js"
import { syncFermentToolScope } from "../tool-scope.js"
import type { FermentUi, FermentUiContext } from "../ui.js"
import { buildWorkerContext } from "../worker-prompt.js"

const VERIFY_TIMEOUT_MS = 60_000

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
	judgeGradeStep(
		stepDescription: string,
		summary: string,
		verificationResult?: { exitCode: number; stdout: string; stderr: string },
		evidence?: PhaseEvidence,
	): Promise<JudgeGrade>
	judgeStepVerification(
		stepDescription: string,
		verificationCommand: string,
		stdout: string,
		stderr: string,
		exitCode: number,
	): Promise<JudgeVerdict>
	onStepCompleted(pi: ExtensionAPI): void
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
	judgeGradeStep,
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
	if (fsmError) return toolErr(fsmError)

	const startCount = runtime.bumpStepStart(f.id, phase.id, step.id)
	if (startCount >= 3) {
		const title = `Step ${step.index}: "${step.description}" has been started ${startCount} times without completing.`
		const retryLabel = "Retry with a revised approach"
		const skipLabel = "Skip this step and move on"
		const pauseLabel = "Pause the ferment for now"

		if (ctx?.ui?.select) {
			const choice = await ctx.ui.select(title, [retryLabel, skipLabel, pauseLabel])
			runtime.markHumanInput()

			if (!choice || choice === pauseLabel) {
				const pauseOutcome = applyAndPersist(f.id, { type: "pause" })
				if (!pauseOutcome.ok) return failedToolResult(pauseOutcome.error)
				syncFermentToolScope(pi, pauseOutcome.ferment)
				return toolOk("Ferment paused at user request.")
			}

			if (choice === skipLabel) {
				const skipOutcome = applyAndPersist(f.id, {
					type: "skip_step",
					phaseId: phase.id,
					stepId: step.id,
				})
				if (!skipOutcome.ok) return failedToolResult(skipOutcome.error)
				runtime.clearStepStart(f.id, phase.id, step.id)
				services.onStepCompleted(pi)
				return toolOk(`Step ${step.index}: "${step.description}" skipped at user request.`)
			}

			runtime.clearStepStart(f.id, phase.id, step.id)
		} else {
			return toolErr(
				`⚠ Stuck loop detected: ${title}

What should we do?

1) Retry with a revised approach
2) Skip this step and move on
3) Pause the ferment for now

Do NOT call start_step again without user input.`,
			)
		}
	}

	const outcome = applyAndPersist(params.ferment_id, {
		type: "start_step",
		phaseId: phase.id,
		stepId: step.id,
	})
	if (!outcome.ok) {
		if (outcome.error.code === "CONCURRENT_NON_PARALLEL_STEP") {
			return toolErr(
				`Cannot start step ${step.index} — step ${outcome.error.runningStepIndex} ("${outcome.error.runningDescription}") is already running and is not parallel-safe. Complete or skip it first.`,
			)
		}
		return failedToolResult(outcome.error)
	}

	const stepHeadRef = services.captureGitHead()
	if (stepHeadRef) runtime.setStepStartRef(params.ferment_id, phase.id, step.id, stepHeadRef)

	const freshPhase = outcome.ferment.phases.find((p) => p.id === phase.id)
	const freshStep = freshPhase?.steps.find((s) => s.id === step.id)
	const workerModel = freshStep?.workerModel ?? "minimax-m2.7"

	const prevStep = freshPhase?.steps.find((st) => st.index === step.index - 1)
	const lowGradeCaution =
		prevStep?.grade && ["C", "D", "F"].includes(prevStep.grade.grade)
			? `\n\n⚠️  Previous step (${prevStep.index}: "${prevStep.description}") received grade ${prevStep.grade.grade}: ${prevStep.grade.rationale}. Apply extra scrutiny to this step — verify edge cases, error handling, and completeness before reporting done.`
			: ""

	const parallelSiblings = freshStep?.canRunParallel
		? (freshPhase?.steps ?? [])
				.filter((st) => st.id !== step.id && st.status === "pending" && st.canRunParallel)
				.map((st) => ({
					step_id: st.id,
					description: st.description,
					worker_model: st.workerModel ?? "minimax-m2.7",
				}))
		: []

	const parallelNote =
		parallelSiblings.length > 0
			? `\nparallel_siblings: ${JSON.stringify(parallelSiblings)}\n\nThese steps are independent — call start_step for each one now and spawn their subagents concurrently. Do not wait for one to finish before starting the next.`
			: ""

	const workerContext =
		freshPhase && freshStep ? services.buildWorkerContext(outcome.ferment, freshPhase, freshStep) : ""
	const contextBlock = workerContext
		? `\n\n--- BEGIN WORKER PROMPT ---\n${workerContext}\n--- END WORKER PROMPT ---\n\nPaste the block above into the subagent's prompt. You may add a single concrete implementation directive at the end if the step description is ambiguous, but do NOT remove or summarize the context block.`
		: ""

	return toolOk(
		`Step ${step.index}: "${step.description}" started.\nphase_id: ${phase.id}\nstep_id: ${step.id}\nworker_model: ${workerModel}\nprovider: kimchi-dev\n\nSpawn a subagent now with provider "kimchi-dev", model "${workerModel}". When it returns, call complete_step with its summary.${lowGradeCaution}${parallelNote}${contextBlock}`,
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
	if (fsmError) return toolErr(fsmError)

	if (!step.verification) {
		const completeOutcome = applyAndPersist(params.ferment_id, {
			type: "complete_step",
			phaseId: phase.id,
			stepId: step.id,
			summary: params.summary,
		})
		if (!completeOutcome.ok) return failedToolResult(completeOutcome.error)
		runtime.clearStepStart(f.id, phase.id, step.id)

		const stepRef = runtime.getStepStartRef(f.id, phase.id, step.id)
		const stepEvidence = stepRef ? services.gatherEvidence(stepRef) : undefined
		const grade = await services.judgeGradeStep(step.description, params.summary ?? "", undefined, stepEvidence)
		const gradeOutcome = applyAndPersist(params.ferment_id, {
			type: "set_step_grade",
			phaseId: phase.id,
			stepId: step.id,
			grade,
		})
		if (!gradeOutcome.ok) return failedToolResult(gradeOutcome.error)

		services.onStepCompleted(pi)
		return toolOk(
			`Step ${step.index}: "${step.description}" done.  Grade: ${grade.grade} — ${grade.rationale}  ${params.summary ?? ""}`,
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
	if (!verifyOutcome.ok) return failedToolResult(verifyOutcome.error)
	runtime.clearStepStart(f.id, phase.id, step.id)

	if (exitCode === 0) {
		const stepRef = runtime.getStepStartRef(f.id, phase.id, step.id)
		const stepEvidence = stepRef ? services.gatherEvidence(stepRef) : undefined
		const grade = await services.judgeGradeStep(
			step.description,
			params.summary ?? "",
			{ exitCode, stdout, stderr },
			stepEvidence,
		)
		const gradeOutcome = applyAndPersist(params.ferment_id, {
			type: "set_step_grade",
			phaseId: phase.id,
			stepId: step.id,
			grade,
		})
		if (!gradeOutcome.ok) return failedToolResult(gradeOutcome.error)
		services.onStepCompleted(pi)
		return toolOk(
			`Step ${step.index}: "${step.description}" done and verified ✓  Grade: ${grade.grade} — ${grade.rationale}`,
		)
	}

	const judgeVerdict = await services.judgeStepVerification(
		step.description,
		step.verification.command,
		stdout,
		stderr,
		exitCode,
	)

	if (judgeVerdict.verdict === "pass") {
		const stepRef = runtime.getStepStartRef(f.id, phase.id, step.id)
		const stepEvidence = stepRef ? services.gatherEvidence(stepRef) : undefined
		const grade = await services.judgeGradeStep(
			step.description,
			params.summary ?? "",
			{ exitCode, stdout, stderr },
			stepEvidence,
		)
		const gradeOutcome = applyAndPersist(params.ferment_id, {
			type: "set_step_grade",
			phaseId: phase.id,
			stepId: step.id,
			grade,
		})
		if (!gradeOutcome.ok) return failedToolResult(gradeOutcome.error)
		services.onStepCompleted(pi)
		return toolOk(
			`Step ${step.index}: "${step.description}" done ✓  Judge: ${judgeVerdict.reason}  Grade: ${grade.grade}`,
		)
	}

	const failOutcome = applyAndPersist(params.ferment_id, {
		type: "fail_step",
		phaseId: phase.id,
		stepId: step.id,
		error: `Verification failed (exit ${exitCode}): ${judgeVerdict.reason}`,
	})
	if (!failOutcome.ok) return failedToolResult(failOutcome.error)

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
		onStepCompleted: (targetPi) => onStepCompleted(targetPi, runtime),
	}
	pi.registerTool({
		name: "start_step",
		label: "Start Step",
		description:
			"Mark a step as running. Returns worker_model and parallel_siblings. See planner instructions in the system prompt for orchestration details.",
		parameters: StepActionParams,
		async execute(_, params, _signal, _onUpdate, ctx) {
			return startStep(runtime, params, { pi, ctx }, stepServices)
		},
	})

	pi.registerTool({
		name: "complete_step",
		label: "Complete Step",
		description:
			"Mark step as done. If the step has a verification command it runs automatically — no need to call verify_step separately.",
		parameters: CompleteStepParams,
		async execute(_, params, signal, onUpdate, ctx) {
			return completeStep(runtime, params, { pi, ctx, signal, onUpdate }, stepServices)
		},
	})

	pi.registerTool({
		name: "verify_step",
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
			if (fsmError) return toolErr(fsmError)

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
			if (!outcome.ok) return failedToolResult(outcome.error)
			onStepCompleted(pi, runtime)

			if (result.success) return toolOk(`✓ "${step.description}" verified.`)
			return toolErr(`✗ "${step.description}" failed (exit ${exitCode}).`)
		},
	})

	pi.registerTool({
		name: "skip_step",
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
			if (fsmError) return toolErr(fsmError)

			const outcome = applyAndPersist(params.ferment_id, {
				type: "skip_step",
				phaseId: phase.id,
				stepId: step.id,
			})
			if (!outcome.ok) return failedToolResult(outcome.error)
			runtime.clearStepStart(f.id, phase.id, step.id)
			onStepCompleted(pi, runtime)
			return toolOk("Step skipped.")
		},
	})

	pi.registerTool({
		name: "fail_step",
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
			if (fsmError) return toolErr(fsmError)

			const outcome = applyAndPersist(params.ferment_id, {
				type: "fail_step",
				phaseId: phase.id,
				stepId: step.id,
				error: params.error,
			})
			if (!outcome.ok) return failedToolResult(outcome.error)
			onStepCompleted(pi, runtime)
			return toolOk(
				`Step ${step.index}: "${step.description}" marked as failed. Use skip_step to skip it, or retry the work and call start_step again.`,
			)
		},
	})
}
