/**
 * Step tools: start_step, complete_step, verify_step, skip_step, fail_step.
 *
 * complete_step is the largest — it auto-runs the verification command (with
 * a 60s timeout), routes non-zero exits through the judge for pass/retry/fail
 * classification, then grades the step.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { StepResult } from "../../../ferment/types.js"
import { validateFsmTransitionWithFerment } from "../fsm-adapter.js"
import { judgeGradeStep, judgeStepVerification } from "../judge.js"
import { onStepCompleted } from "../nudge.js"
import { bumpStepStart, captureJudgeContext, clearStepStart, getStorage } from "../state.js"
import { applyAndPersist, failedToolResult, resolvePhase, resolveStep, toolErr, toolOk } from "../tool-helpers.js"
import { CompleteStepParams, FailStepParams, StepActionParams, VerifyParams } from "../tool-schemas.js"

const VERIFY_TIMEOUT_MS = 60_000

const validateFsmTransition = (
	f: Parameters<typeof validateFsmTransitionWithFerment>[0],
	event: Parameters<typeof validateFsmTransitionWithFerment>[1],
	params?: Parameters<typeof validateFsmTransitionWithFerment>[2],
): string | null => validateFsmTransitionWithFerment(f, event, params).error ?? null

export function registerStepTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "start_step",
		label: "Start Step",
		description:
			"Mark a step as running. Returns worker_model and parallel_siblings. See planner instructions in the system prompt for orchestration details.",
		parameters: StepActionParams,
		async execute(_, params) {
			// Resolve phase and step (host concern — fuzzy lookup).
			const f = getStorage().get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")
			const phase = resolvePhase(f, params.phase_id)
			if (!phase) return toolErr("Phase not found.")
			const step = resolveStep(phase, params.step_id)
			if (!step) {
				return toolErr(
					`Step not found. Steps: ${phase.steps.map((st) => `[${st.id}] ${st.index}. ${st.description}`).join(", ")}`,
				)
			}

			// FSM validation: ensure step start is allowed
			const fsmError = validateFsmTransition(f, "START_STEP", { phaseId: phase.id, stepId: step.id })
			if (fsmError) return toolErr(fsmError)

			// Stuck-loop detection (UI-flow concern, not domain — runs before transition).
			// Counter is held at threshold so every subsequent call also blocks until
			// complete_step or skip_step clears it.
			const startCount = bumpStepStart(f.id, phase.id, step.id)
			if (startCount >= 3) {
				return toolErr(
					`⚠ Stuck loop detected: step ${step.index} "${step.description}" has been started ${startCount} times without completing. Stop and ask the user: should we retry with a revised approach, skip this step, or pause the ferment? Do NOT call start_step again without user input.`,
				)
			}

			// Apply the transition. CONCURRENT_NON_PARALLEL_STEP errors get a
			// custom message that matches the original LLM-facing wording.
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

			// Reload step from the post-transition ferment for the response.
			const freshPhase = outcome.ferment.phases.find((p) => p.id === phase.id)
			const freshStep = freshPhase?.steps.find((s) => s.id === step.id)
			const workerModel = freshStep?.workerModel ?? "minimax-m2.7"

			// Check if previous step in same phase got a low grade — inject caution
			const prevStep = freshPhase?.steps.find((st) => st.index === step.index - 1)
			const lowGradeCaution =
				prevStep?.grade && ["C", "D", "F"].includes(prevStep.grade.grade)
					? `\n\n⚠️  Previous step (${prevStep.index}: "${prevStep.description}") received grade ${prevStep.grade.grade}: ${prevStep.grade.rationale}. Apply extra scrutiny to this step — verify edge cases, error handling, and completeness before reporting done.`
					: ""

			// Find pending parallel siblings (excluding this step).
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

			return toolOk(
				`Step ${step.index}: "${step.description}" started.\nphase_id: ${phase.id}\nstep_id: ${step.id}\nworker_model: ${workerModel}\nprovider: kimchi-dev\n\nSpawn a subagent now with provider "kimchi-dev", model "${workerModel}", and a prompt describing exactly what to implement for this step. When it returns, call complete_step with its summary.${lowGradeCaution}${parallelNote}`,
			)
		},
	})

	pi.registerTool({
		name: "complete_step",
		label: "Complete Step",
		description:
			"Mark step as done. If the step has a verification command it runs automatically — no need to call verify_step separately.",
		parameters: CompleteStepParams,
		async execute(_, params, signal, onUpdate, ctx) {
			captureJudgeContext(ctx?.model, ctx?.modelRegistry)

			const f = getStorage().get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")
			const phase = resolvePhase(f, params.phase_id)
			if (!phase) return toolErr("Phase not found.")
			const step = resolveStep(phase, params.step_id)
			if (!step) return toolErr("Step not found.")

			// FSM validation: ensure step completion is allowed
			const fsmError = validateFsmTransition(f, "COMPLETE_STEP", { phaseId: phase.id, stepId: step.id })
			if (fsmError) return toolErr(fsmError)

			// Path A: no verification command — straight to done + grade.
			if (!step.verification) {
				const completeOutcome = applyAndPersist(params.ferment_id, {
					type: "complete_step",
					phaseId: phase.id,
					stepId: step.id,
				})
				if (!completeOutcome.ok) return failedToolResult(completeOutcome.error)
				clearStepStart(f.id, phase.id, step.id)

				const grade = await judgeGradeStep(step.description, params.summary ?? "")
				const gradeOutcome = applyAndPersist(params.ferment_id, {
					type: "set_step_grade",
					phaseId: phase.id,
					stepId: step.id,
					grade,
				})
				if (!gradeOutcome.ok) return failedToolResult(gradeOutcome.error)

				onStepCompleted(pi)
				return toolOk(
					`Step ${step.index}: "${step.description}" done.  Grade: ${grade.grade} — ${grade.rationale}  ${params.summary ?? ""}`,
				)
			}

			// Path B: run the verification command (host concern — bash I/O).
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
					const execResult = await (controller.tools.bash.execute as any)(
						"",
						{ command: step.verification.command },
						verifySignal,
						onUpdate,
						ctx,
					)
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

			const verifyResult: StepResult = {
				success: exitCode === 0,
				exitCode,
				stdout,
				stderr,
				completedAt: new Date().toISOString(),
			}

			// Apply verify_step transition (sets status to verified or done).
			const verifyOutcome = applyAndPersist(params.ferment_id, {
				type: "verify_step",
				phaseId: phase.id,
				stepId: step.id,
				result: verifyResult,
			})
			if (!verifyOutcome.ok) return failedToolResult(verifyOutcome.error)
			clearStepStart(f.id, phase.id, step.id)

			// Path B.1: clean pass — grade and return.
			if (exitCode === 0) {
				const grade = await judgeGradeStep(step.description, params.summary ?? "", { exitCode, stdout, stderr })
				const gradeOutcome = applyAndPersist(params.ferment_id, {
					type: "set_step_grade",
					phaseId: phase.id,
					stepId: step.id,
					grade,
				})
				if (!gradeOutcome.ok) return failedToolResult(gradeOutcome.error)
				onStepCompleted(pi)
				return toolOk(
					`Step ${step.index}: "${step.description}" done and verified ✓  Grade: ${grade.grade} — ${grade.rationale}`,
				)
			}

			// Path B.2: non-zero exit — judge classifies as pass/retry/fail.
			const judgeVerdict = await judgeStepVerification(
				step.description,
				step.verification.command,
				stdout,
				stderr,
				exitCode,
			)

			if (judgeVerdict.verdict === "pass") {
				const grade = await judgeGradeStep(step.description, params.summary ?? "", { exitCode, stdout, stderr })
				const gradeOutcome = applyAndPersist(params.ferment_id, {
					type: "set_step_grade",
					phaseId: phase.id,
					stepId: step.id,
					grade,
				})
				if (!gradeOutcome.ok) return failedToolResult(gradeOutcome.error)
				onStepCompleted(pi)
				return toolOk(
					`Step ${step.index}: "${step.description}" done ✓  Judge: ${judgeVerdict.reason}  Grade: ${grade.grade}`,
				)
			}

			// Both retry and fail map to fail_step in storage.
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
		},
	})

	pi.registerTool({
		name: "verify_step",
		label: "Verify Step",
		description: "Run verification command and record result.",
		parameters: VerifyParams,
		async execute(_, params, signal, onUpdate, ctx) {
			const f = getStorage().get(params.ferment_id)
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
				completedAt: new Date().toISOString(),
			}

			const outcome = applyAndPersist(params.ferment_id, {
				type: "verify_step",
				phaseId: phase.id,
				stepId: step.id,
				result,
			})
			if (!outcome.ok) return failedToolResult(outcome.error)
			onStepCompleted(pi)

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
			const f = getStorage().get(params.ferment_id)
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
			clearStepStart(f.id, phase.id, step.id)
			onStepCompleted(pi)
			return toolOk("Step skipped.")
		},
	})

	pi.registerTool({
		name: "fail_step",
		label: "Fail Step",
		description: "Mark a step as failed with an error message.",
		parameters: FailStepParams,
		async execute(_, params) {
			const f = getStorage().get(params.ferment_id)
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
			onStepCompleted(pi)
			return toolOk(
				`Step ${step.index}: "${step.description}" marked as failed. Use skip_step to skip it, or retry the work and call start_step again.`,
			)
		},
	})
}
