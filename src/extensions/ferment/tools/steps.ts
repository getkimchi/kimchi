/**
 * Step tools: start_step, complete_step, verify_step, skip_step, fail_step.
 *
 * complete_step is the largest — it auto-runs the verification command (with
 * a 60s timeout), routes non-zero exits through the judge for pass/retry/fail
 * classification, then grades the step.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { StepResult } from "../../../ferment/types.js"
import { judgeGradeStep, judgeStepVerification } from "../judge.js"
import { onStepCompleted } from "../nudge.js"
import { bumpStepStart, captureJudgeContext, clearStepStart, getStorage, setActive } from "../state.js"
import { resolvePhase, resolveStep, toolErr } from "../tool-helpers.js"
import { CompleteStepParams, FailStepParams, StepActionParams, VerifyParams } from "../tool-schemas.js"

const VERIFY_TIMEOUT_MS = 60_000

export function registerStepTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "start_step",
		label: "Start Step",
		description:
			"Mark a step as running. Returns worker_model and parallel_siblings. See planner instructions in the system prompt for orchestration details.",
		parameters: StepActionParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")
			const phase = resolvePhase(f, params.phase_id)
			if (!phase) return toolErr("Phase not found.")
			const step = resolveStep(phase, params.step_id)
			if (!step) {
				return toolErr(
					`Step not found. Steps: ${phase.steps.map((st) => `[${st.id}] ${st.index}. ${st.description}`).join(", ")}`,
				)
			}
			// Block concurrent start only when the existing running step is NOT parallel-safe
			// (or the step being started is not parallel-safe either).
			const alreadyRunning = phase.steps.find((st) => st.status === "running" && st.id !== step.id)
			if (alreadyRunning && (!alreadyRunning.canRunParallel || !step.canRunParallel)) {
				return toolErr(
					`Cannot start step ${step.index} — step ${alreadyRunning.index} ("${alreadyRunning.description}") is already running and is not parallel-safe. Complete or skip it first.`,
				)
			}
			// Stuck-loop detection: same step started 3+ times without completing.
			// The counter is held at the threshold so every subsequent call also blocks
			// until complete_step or skip_step clears it.
			const startCount = bumpStepStart(f.id, phase.id, step.id)
			if (startCount >= 3) {
				return toolErr(
					`⚠ Stuck loop detected: step ${step.index} "${step.description}" has been started ${startCount} times without completing. Stop and ask the user: should we retry with a revised approach, skip this step, or pause the ferment? Do NOT call start_step again without user input.`,
				)
			}

			const r = s.startStep(f.id, phase.id, step.id)
			if (!r) return toolErr("Step start failed.")
			setActive(r)
			const workerModel = step.workerModel ?? "minimax-m2.7"

			// Find pending parallel siblings (excluding this step) so the planner
			// can start them all concurrently without waiting for this one to finish.
			const parallelSiblings = step.canRunParallel
				? phase.steps
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

			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `Step ${step.index}: "${step.description}" started.\nphase_id: ${phase.id}\nstep_id: ${step.id}\nworker_model: ${workerModel}\nprovider: kimchi-dev\n\nSpawn a subagent now with provider "kimchi-dev", model "${workerModel}", and a prompt describing exactly what to implement for this step. When it returns, call complete_step with its summary.${parallelNote}`,
					},
				],
			}
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
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")
			const phase = resolvePhase(f, params.phase_id)
			if (!phase) return toolErr("Phase not found.")
			const step = resolveStep(phase, params.step_id)
			if (!step) return toolErr("Step not found.")
			const r = s.completeStep(f.id, phase.id, step.id)
			if (!r) return toolErr("Step completion failed.")
			setActive(r)
			// Clear stuck-loop counter on successful completion
			clearStepStart(f.id, phase.id, step.id)

			if (!step.verification) {
				// Grade step even without verification (summary-based)
				const grade = await judgeGradeStep(step.description, params.summary ?? "")
				const graded = s.setStepGrade(f.id, phase.id, step.id, grade)
				if (graded) setActive(graded)
				onStepCompleted(pi)
				return {
					details: undefined,
					content: [
						{
							type: "text",
							text: `Step ${step.index}: "${step.description}" done.  Grade: ${grade.grade} — ${grade.rationale}  ${params.summary ?? ""}`,
						},
					],
				}
			}

			// ── Auto-verify: run bash verification command ──
			// Cap verification at 60 seconds — a hung "npm test" should not block forever.
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
				} catch (err) {
					exitCode = 1
					stderr =
						err instanceof Error && err.name === "TimeoutError"
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
			const verified = s.verifyStep(f.id, phase.id, step.id, verifyResult)
			if (verified) setActive(verified)

			if (exitCode === 0) {
				const grade = await judgeGradeStep(step.description, params.summary ?? "", { exitCode, stdout, stderr })
				const graded = s.setStepGrade(f.id, phase.id, step.id, grade)
				if (graded) setActive(graded)
				onStepCompleted(pi)
				return {
					details: undefined,
					content: [
						{
							type: "text",
							text: `Step ${step.index}: "${step.description}" done and verified ✓  Grade: ${grade.grade} — ${grade.rationale}`,
						},
					],
				}
			}

			// Non-zero exit — judge classifies it as pass/retry/fail.
			const judgeVerdict = await judgeStepVerification(
				step.description,
				step.verification.command,
				stdout,
				stderr,
				exitCode,
			)

			if (judgeVerdict.verdict === "pass") {
				// Judge says non-zero exit is acceptable — grade it
				const grade = await judgeGradeStep(step.description, params.summary ?? "", { exitCode, stdout, stderr })
				const graded = s.setStepGrade(f.id, phase.id, step.id, grade)
				if (graded) setActive(graded)
				onStepCompleted(pi)
				return {
					details: undefined,
					content: [
						{
							type: "text",
							text: `Step ${step.index}: "${step.description}" done ✓  Judge: ${judgeVerdict.reason}  Grade: ${grade.grade}`,
						},
					],
				}
			}

			if (judgeVerdict.verdict === "retry") {
				const failed = s.failStep(
					f.id,
					phase.id,
					step.id,
					`Verification failed (exit ${exitCode}): ${judgeVerdict.reason}`,
				)
				if (failed) setActive(failed)
				return toolErr(
					`Step ${step.index} verification failed — retry suggested.\nExit: ${exitCode}\nJudge: ${judgeVerdict.reason}\nstdout: ${stdout.slice(0, 500)}\nstderr: ${stderr.slice(0, 500)}`,
				)
			}

			// verdict === "fail"
			const failed = s.failStep(
				f.id,
				phase.id,
				step.id,
				`Verification failed (exit ${exitCode}): ${judgeVerdict.reason}`,
			)
			if (failed) setActive(failed)
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
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")
			const phase = resolvePhase(f, params.phase_id)
			if (!phase) return toolErr("Phase not found.")
			const step = resolveStep(phase, params.step_id)
			if (!step) return toolErr("Step not found.")

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

			const r = s.verifyStep(f.id, phase.id, step.id, result)
			if (r) setActive(r)
			onStepCompleted(pi)

			if (result.success)
				return { details: undefined, content: [{ type: "text", text: `✓ "${step.description}" verified.` }] }
			return toolErr(`✗ "${step.description}" failed (exit ${exitCode}).`)
		},
	})

	pi.registerTool({
		name: "skip_step",
		label: "Skip Step",
		description: "Skip a step.",
		parameters: StepActionParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")
			const phase = resolvePhase(f, params.phase_id)
			if (!phase) return toolErr("Phase not found.")
			const step = resolveStep(phase, params.step_id)
			if (!step) return toolErr("Step not found.")
			const r = s.skipStep(f.id, phase.id, step.id)
			if (!r) return toolErr("Step not found.")
			setActive(r)
			clearStepStart(f.id, phase.id, step.id)
			onStepCompleted(pi)
			return { details: undefined, content: [{ type: "text", text: "Step skipped." }] }
		},
	})

	pi.registerTool({
		name: "fail_step",
		label: "Fail Step",
		description: "Mark a step as failed with an error message.",
		parameters: FailStepParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")
			const phase = resolvePhase(f, params.phase_id)
			if (!phase) return toolErr("Phase not found.")
			const step = resolveStep(phase, params.step_id)
			if (!step) return toolErr("Step not found.")
			const r = s.failStep(f.id, phase.id, step.id, params.error)
			if (!r) return toolErr("Failed to mark step as failed.")
			setActive(r)
			onStepCompleted(pi)
			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `Step ${step.index}: "${step.description}" marked as failed. Use skip_step to skip it, or retry the work and call start_step again.`,
					},
				],
			}
		},
	})
}
