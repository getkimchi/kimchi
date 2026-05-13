/**
 * Phase tools: activate_phase, refine_phase, complete_phase, skip_phase, fail_phase.
 *
 * complete_phase is the most complex — in plan mode it surfaces a TUI dropdown
 * with a structured phase review and returns the user's choice in the tool
 * result. It must not queue follow-up user messages from the tool handler.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Static } from "typebox"
import { findFirstPlannedPhase } from "../../../ferment/engine.js"
import type { Ferment, JudgeGrade } from "../../../ferment/types.js"
import { truncateLabel } from "../colors.js"
import { formatDecisionsAndMemories, formatScopingContext } from "../format.js"
import { validateFsmTransitionWithFerment } from "../fsm-adapter.js"
import { flaggedVerdicts, renderGateGuidance } from "../gate-registry.js"
import { validateGatesOrErr } from "../gate-validation.js"
import type { JudgeFlag } from "../judge.js"
import { isPlanFerment } from "../modes.js"
import { onPhaseCompleted } from "../nudge.js"
import { type PhaseEvidence, captureGitHead, gatherPhaseEvidence } from "../phase-evidence.js"
import { type ProjectCheckResult, runProjectChecks, summarizeProjectChecks } from "../project-tests.js"
import { hashFlags, writeEscalationArtifact, writeReviewEvidence } from "../review-evidence.js"
import { type FermentRuntime, defaultFermentRuntime } from "../runtime.js"
import { MAX_BLOCK_RETRIES } from "../state.js"
import { createApplyAndPersist, failedToolResult, resolvePhase, toolErr, toolOk } from "../tool-helpers.js"
import { ActivateParams, CompletePhaseParams, FailPhaseParams, RefineParams, SkipPhaseParams } from "../tool-schemas.js"
import { syncFermentToolScope } from "../tool-scope.js"
import type { FermentUi, FermentUiContext } from "../ui.js"

type CompletePhaseArgs = Static<typeof CompletePhaseParams>
type ToolResult = ReturnType<typeof toolOk> | ReturnType<typeof toolErr>

type PhaseUiContext = Omit<Partial<FermentUiContext>, "ui"> & { ui?: Partial<FermentUi> }

export interface PhaseHandlerServices {
	captureGitHead(): string | undefined
	gatherEvidence(ref: string): PhaseEvidence | undefined
	/** Run the project's own automated checks (tests, lint, typecheck). Returns
	 *  a result describing what was discovered + what passed/failed. Stubbed in
	 *  unit tests; the default delegates to `runProjectChecks` against the
	 *  ferment's worktree path. */
	runProjectChecks(cwd: string): ProjectCheckResult
	onPhaseCompleted(runtime: FermentRuntime): void
	isPlanMode(ferment: Ferment): boolean
}

export interface PhaseExecutionContext {
	pi: ExtensionAPI
	ctx?: PhaseUiContext
}

export const defaultPhaseHandlerServices: PhaseHandlerServices = {
	captureGitHead,
	gatherEvidence: gatherPhaseEvidence,
	runProjectChecks: (cwd) => runProjectChecks(cwd),
	onPhaseCompleted,
	isPlanMode: isPlanFerment,
}

const validateFsmTransition = (
	f: Parameters<typeof validateFsmTransitionWithFerment>[0],
	event: Parameters<typeof validateFsmTransitionWithFerment>[1],
	params?: Parameters<typeof validateFsmTransitionWithFerment>[2],
): string | null => validateFsmTransitionWithFerment(f, event, params).error ?? null

/** Project-check failures become synthetic block flags fed into the same
 *  retry/escalation pipeline as agent-emitted gate flags. Validation failure
 *  is ground truth — no agent verdict should override it. We validate the
 *  command's shape (runner installed, script wired), never execute the suite,
 *  so the failure here means "you claim a suite exists but it isn't
 *  installable here", not "tests failed". */
function flagsFromProjectChecks(result: ProjectCheckResult): JudgeFlag[] {
	if (!result.discovered || !result.anyFailed) return []
	return result.checks
		.filter((c) => c.exitCode !== 0)
		.map((c) => ({
			problem: `Project ${c.kind} command (\`${c.command}\`) did not validate.`,
			evidence: (c.stderr || c.stdout || "(no detail)").slice(0, 160).trim(),
			severity: "block" as const,
			redirect: `Wire ${c.kind} properly before completing this phase — make \`${c.command}\` a real, installable command (resolve the runner, fix the script).`,
		}))
}

/** Agent-emitted "flag" verdicts become synthetic block flags. Mirrors the
 *  shape of project-check flags so the retry/escalation/hash machinery is
 *  uniform regardless of who flagged the work. Accepts the TypeBox-derived
 *  shape (id widened to string) so the tool boundary doesn't need to cast. */
function flagsFromGateVerdicts(
	verdicts: ReadonlyArray<{ id: string; verdict: string; rationale: string; evidence: string }>,
): JudgeFlag[] {
	return flaggedVerdicts(verdicts).map((v) => ({
		problem: `Gate ${v.id} flagged: ${v.rationale}`,
		evidence: v.evidence,
		severity: "block" as const,
		redirect: `Address ${v.id} before completing this phase. The flag was self-reported — fix the underlying problem and re-submit the gate with verdict 'pass' (or 'omitted' with rationale if the gate truly does not apply).`,
	}))
}

export async function completePhase(
	runtime: FermentRuntime,
	params: CompletePhaseArgs,
	{ pi, ctx }: PhaseExecutionContext,
	services: PhaseHandlerServices = defaultPhaseHandlerServices,
): Promise<ToolResult> {
	const applyAndPersist = createApplyAndPersist(runtime)
	runtime.captureJudgeContext(ctx?.model, ctx?.modelRegistry)

	// Step 1: resolve the phase (host concern — fuzzy lookup).
	const f = runtime.getStorage().get(params.ferment_id)
	if (!f) return toolErr("Ferment not found.")
	const phase = resolvePhase(f, params.phase_id)
	if (!phase) return toolErr("Phase not found.")

	// FSM validation: complete_phase requires all phases to be terminal
	const fsmError = validateFsmTransition(f, "COMPLETE_PHASE", { phaseId: phase.id })
	if (fsmError) return toolErr(fsmError)

	// Step 2a: validate gate coverage + per-verdict shape. Phase-scope is the
	// one tool that does NOT short-circuit on a flag — flags feed the
	// retry/escalation pipeline below via flagsFromGateVerdicts. Coverage
	// failure or malformed shape still return a tool error immediately.
	const gateError = validateGatesOrErr(params.gates, {
		turn: "complete_phase",
		flagPolicy: "coverage-only",
	})
	if (gateError) return gateError

	// Capture the phase shape for evidence/review artifacts.
	const stepSummariesText = phase.steps
		.map((st) => `  ${st.index}. ${st.description} [${st.status}]${st.grade ? ` Grade:${st.grade.grade}` : ""}`)
		.join("\n")

	// Step 2b: deterministic gate — validate that the project's own checks
	// (tests, lint, typecheck) are wired correctly. We do NOT execute them
	// (see project-tests.ts for why). Failures here become block flags.
	const projectChecks = services.runProjectChecks(f.worktree.path)
	const projectCheckSummary = summarizeProjectChecks(projectChecks)
	const deterministicFlags = flagsFromProjectChecks(projectChecks)

	// Step 2c: gather code-evidence for the audit log. The evidence is no
	// longer consumed by a judge — it's persisted so post-mortem analysis
	// can correlate gate verdicts with the actual diff.
	const startRef = runtime.getPhaseStartRef(params.ferment_id, phase.id)
	const evidence = startRef ? services.gatherEvidence(startRef) : undefined

	// Step 2d: combine flags. Project-check flags come from disk truth;
	// gate flags come from the agent's own structured verdicts. Both feed
	// the same retry/escalation pipeline.
	const gateFlags = flagsFromGateVerdicts(params.gates)
	const mergedFlags = [...deterministicFlags, ...gateFlags]
	const blockFlags = mergedFlags.filter((fl) => fl.severity === "block")
	const warnFlags = mergedFlags.filter((fl) => fl.severity === "warn")

	// Step 2e: persist per-attempt evidence to disk. Best-effort — never
	// blocks the flow even if the write fails.
	const reviewAttemptForLog = runtime.getBlockRetry(params.ferment_id, phase.id) + 1
	const derivedGrade = blockFlags.length > 0 ? "F" : warnFlags.length > 0 ? "B" : "A"
	const rationale =
		blockFlags.length > 0
			? `${blockFlags.length} block flag(s) raised — see attached gate verdicts and project checks.`
			: warnFlags.length > 0
				? `Phase advanced with ${warnFlags.length} advisory warning(s).`
				: "All gates pass; project checks validate."
	writeReviewEvidence({
		fermentId: f.id,
		phaseId: phase.id,
		phaseName: phase.name,
		attempt: reviewAttemptForLog,
		goal: phase.goal,
		summary: params.summary ?? "",
		stepSummaries: stepSummariesText,
		outcome: { flags: mergedFlags, grade: derivedGrade, rationale },
		diffAvailable: evidence?.available ?? false,
		diffFilesChanged: evidence?.filesChanged,
		projectChecks,
	})

	// Step 3: if either the reviewer or the project checks raised block flags,
	// refuse phase advancement. This is the self-heal loop: agent gets
	// concrete redirects, fixes the work, and calls complete_phase again.
	// Block-retry counter bounds the loop at MAX_BLOCK_RETRIES; on overflow
	// we escalate to the user.
	//
	// Failure-hash short-circuit: if the SAME set of block flags repeats
	// (same problems, same redirects), the agent has not made progress.
	// Don't waste turns retrying the same broken state — jump straight to
	// escalation. Mirrors GSD-2's verification-retry-policy.
	if (blockFlags.length > 0) {
		const retry = runtime.bumpBlockRetry(params.ferment_id, phase.id)
		const flagHash = hashFlags(blockFlags)
		const sameFailureRepeated = runtime.recordBlockHashAndCheckRepeat(params.ferment_id, phase.id, flagHash)
		const flagLines = blockFlags
			.map((fl) => `  ⛔ ${fl.problem}\n     evidence: ${fl.evidence}\n     redirect: ${fl.redirect}`)
			.join("\n")
		const warnLines =
			warnFlags.length > 0
				? `\n\nAdvisory warnings (do not block):\n${warnFlags
						.map((fl) => `  ⚠ ${fl.problem}\n     redirect: ${fl.redirect}`)
						.join("\n")}`
				: ""

		if (retry > MAX_BLOCK_RETRIES || sameFailureRepeated) {
			// Self-heal loop exhausted. Write a structured escalation artifact
			// the user can resolve from CLI or any non-TUI surface, then if a
			// TUI is present surface the same options as a dropdown.
			writeEscalationArtifact({
				fermentId: f.id,
				phaseId: phase.id,
				phaseName: phase.name,
				flags: blockFlags,
				maxRetries: MAX_BLOCK_RETRIES,
			})

			let userChoice: string | undefined
			if (ctx?.ui?.select) {
				const reason = sameFailureRepeated
					? "same block flags repeated — no progress between attempts"
					: `still blocking after ${MAX_BLOCK_RETRIES} retries`
				const reviewTitle = [
					`Phase ${phase.index}: "${phase.name}" — reviewer ${reason}`,
					"",
					"Block flags:",
					...blockFlags.map((fl) => `  - ${fl.problem}`),
				].join("\n")
				userChoice = await ctx.ui.select(reviewTitle, [
					"Override and proceed (mark phase done)",
					"Pause ferment for manual fix",
					"Abandon ferment",
				])
				runtime.markHumanInput()
			}

			if (userChoice === "Override and proceed (mark phase done)") {
				runtime.clearBlockRetry(params.ferment_id, phase.id)
				// fall through to "advance phase" path below
			} else if (userChoice === "Abandon ferment") {
				const abandonOutcome = applyAndPersist(params.ferment_id, {
					type: "abandon",
					reason: "user abandoned after block retries exhausted",
				})
				if (abandonOutcome.ok) runtime.setActive(abandonOutcome.ferment)
				return toolErr(`Phase "${phase.name}" abandoned at user request after ${MAX_BLOCK_RETRIES} block retries.`)
			} else {
				// Default to pause if no UI or user picked Pause.
				const pauseOutcome = applyAndPersist(params.ferment_id, { type: "pause" })
				if (pauseOutcome.ok) {
					runtime.setActive(pauseOutcome.ferment)
					syncFermentToolScope(pi, pauseOutcome.ferment)
				}
				const reasonNote = sameFailureRepeated
					? "the reviewer raised the same block flags twice in a row — agent made no progress against them"
					: `the reviewer raised block flags ${retry - 1} times in a row and the self-heal loop did not converge`
				return toolErr(
					`Phase "${phase.name}" cannot complete — ${reasonNote}.\n\n${flagLines}${warnLines}\n\nFerment paused. An escalation artifact was written under .kimchi/ferments/${f.id}/escalations/phase-${phase.id}.json. The user must intervene before any further ferment tool calls.`,
				)
			}
		} else {
			// Within retry budget — surface flags and refuse advancement.
			// The first block flag becomes the corrective step for the next
			// attempt (in case the agent loses context across turns).
			runtime.setCorrectiveStep(params.ferment_id, phase.id, blockFlags[0].redirect)
			const projectChecksNote = projectChecks.discovered ? `\n${projectCheckSummary}` : ""
			return toolErr(
				`Phase "${phase.name}" cannot complete — reviewer raised ${blockFlags.length} block flag(s) (retry ${retry}/${MAX_BLOCK_RETRIES}).${projectChecksNote}\n\n${flagLines}${warnLines}\n\nFix the issues above and call complete_phase again with an updated summary.`,
			)
		}
	}

	// Step 4: no block flags. Transition phase to completed.
	const completeOutcome = applyAndPersist(params.ferment_id, {
		type: "complete_phase",
		phaseId: phase.id,
		summary: params.summary,
	})
	if (!completeOutcome.ok) return failedToolResult(completeOutcome.error)

	// Step 3a: clear the block-retry counter — phase advanced cleanly.
	runtime.clearBlockRetry(params.ferment_id, phase.id)

	// Step 4: build a JudgeGrade from the gate verdicts for backwards compat
	// with the state machine's set_phase_grade event + the planner-supplement
	// self-improvement section. The grade is derived deterministically from
	// the verdict mix (block→F, warn→B, all pass→A) — no LLM call.
	const phaseGrade: JudgeGrade = {
		grade: derivedGrade,
		rationale,
		gradedAt: runtime.nowIso(),
		deltas: warnFlags.map((fl) => ({
			category: "correctness",
			expected: fl.redirect,
			actual: fl.problem,
			severity: "minor",
		})),
	}
	const gradeOutcome = applyAndPersist(params.ferment_id, {
		type: "set_phase_grade",
		phaseId: phase.id,
		grade: phaseGrade,
	})
	if (!gradeOutcome.ok) return failedToolResult(gradeOutcome.error)

	// Step 4b: if any warns remain, plant them as the corrective step so the
	// next phase's planner supplement carries the redirect text.
	if (warnFlags.length > 0) {
		runtime.setCorrectiveStep(params.ferment_id, phase.id, warnFlags[0].redirect)
	}

	services.onPhaseCompleted(runtime)
	const fresh = gradeOutcome.ferment
	const next = fresh.phases.find((p) => p.status === "planned")
	const warnSection =
		warnFlags.length > 0
			? `\n\nAdvisory warnings carried over:\n${warnFlags.map((fl) => `  ⚠ ${fl.problem} — ${fl.redirect}`).join("\n")}`
			: ""
	const projectChecksLine = projectChecks.discovered ? `\n${projectCheckSummary}` : ""
	const gradeNote = `  Grade: ${derivedGrade} — ${rationale}`

	if (!next) {
		return toolOk(
			`Phase done.${gradeNote}${projectChecksLine}${warnSection}\nAll phases terminal. Use complete_ferment.`,
		)
	}

	// Plan-mode TUI gate: dropdown review of completed phase + next-phase preview.
	if (services.isPlanMode(fresh) && ctx?.ui?.select) {
		const MAX_STEP_DESC = 80
		const completedPhase = fresh.phases.find((p) => p.id === phase.id)
		const stepLines =
			completedPhase?.steps
				.map((st) => {
					const icon =
						st.status === "done" || st.status === "verified"
							? "✓"
							: st.status === "skipped"
								? "⊘"
								: st.status === "failed"
									? "✗"
									: "○"
					const g = st.grade ? `  ${st.grade.grade}` : ""
					const desc = truncateLabel(st.description, MAX_STEP_DESC)
					return `  ${icon} ${st.index}. ${desc}${g}`
				})
				.join("\n") ?? ""

		const reviewTitle = [
			`Phase ${phase.index}: "${phase.name}"  ${phaseGrade.grade}`,
			truncateLabel(phaseGrade.rationale, 200),
			"",
			"Steps completed:",
			stepLines,
			"",
			`Next → Phase ${next.index}: "${next.name}"`,
			truncateLabel(next.goal, 200),
		].join("\n")

		const choice = await ctx.ui.select(reviewTitle, [
			`Proceed to Phase ${next.index}`,
			"Pause here",
			"Let me say something",
		])
		runtime.markHumanInput()

		if (!choice || choice === "Pause here") {
			const pauseOutcome = applyAndPersist(fresh.id, { type: "pause" })
			if (pauseOutcome.ok) runtime.setActive(pauseOutcome.ferment)
			if (pauseOutcome.ok) syncFermentToolScope(pi, pauseOutcome.ferment)
			// LLM-1616: no sendUserMessage here — the tool result text carries
			// the pause notification, and the agent's turn loop handles the
			// paused state without an additional queued nudge.
			return toolOk(`Phase done.${gradeNote}${projectChecksLine}${warnSection}\nFerment paused at user request.`)
		}
		if (choice === "Let me say something") {
			// LLM-1616: do NOT queue a sendUserMessage from inside a completion
			// tool — it triggers post-completion turns that race complete_ferment
			// and cause Terminal Bench timeouts. The user's direction text rides
			// in the tool result instead.
			const custom = ctx.ui.input ? await ctx.ui.input("Your message:", "") : undefined
			if (custom) {
				return toolOk(`Phase done.${gradeNote}${projectChecksLine}${warnSection}\nUser direction: ${custom}`)
			}
			return toolOk(`Phase done.${gradeNote}${projectChecksLine}${warnSection}\nAwaiting user direction.`)
		}
		// LLM-1616: no sendUserMessage on Proceed — the agent's normal turn loop
		// will pick up the next phase via the tool-result text + reactive nudge.
		return toolOk(
			`Phase done.${gradeNote}${projectChecksLine}${warnSection}\nUser confirmed: proceed to Phase ${next.index}.`,
		)
	}

	return toolOk(`Phase done.${gradeNote}${projectChecksLine}${warnSection}\nNext: "${next.name}".`)
}

export function registerPhaseTools(pi: ExtensionAPI, runtime: FermentRuntime = defaultFermentRuntime): void {
	const applyAndPersist = createApplyAndPersist(runtime)
	const phaseServices: PhaseHandlerServices = {
		...defaultPhaseHandlerServices,
		onPhaseCompleted: () => onPhaseCompleted(runtime),
	}
	pi.registerTool({
		name: "activate_phase",
		label: "Activate Phase",
		description: "Start a planned phase.",
		parameters: ActivateParams,
		async execute(_, params) {
			// Resolution is a host concern (fuzzy lookup) — find the phase first,
			// then dispatch to the right state-machine command.
			const f = runtime.getStorage().get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")

			let target = params.phase_id ? f.phases.find((p) => p.id === params.phase_id) : undefined
			if (!target && params.phase_id) {
				const name = params.phase_id.toLowerCase()
				target = f.phases.find((p) => p.name.toLowerCase().includes(name))
			}
			if (!target) target = f.phases.find((p) => p.status === "failed") ?? findFirstPlannedPhase(f)
			if (!target) return toolErr("No planned or failed phases to activate.")

			// FSM validation: ensure phase activation is allowed
			const fsmError = validateFsmTransition(f, "ACTIVATE_PHASE", { phaseId: target.id })
			if (fsmError) return toolErr(fsmError)

			// Detect parallel group — activate all siblings at once
			if (target.groupIndex !== undefined) {
				const outcome = applyAndPersist(params.ferment_id, {
					type: "activate_phase_group",
					groupIndex: target.groupIndex,
				})
				if (!outcome.ok) return failedToolResult(outcome.error)

				// Capture git HEAD per phase so the grader can diff each one independently.
				const headRef = phaseServices.captureGitHead()
				if (headRef) {
					for (const p of outcome.ferment.phases) {
						if (p.groupIndex === target.groupIndex && p.status === "active") {
							runtime.setPhaseStartRef(params.ferment_id, p.id, headRef)
						}
					}
				}

				const fresh = outcome.ferment
				const groupPhases = fresh.phases.filter((p) => p.groupIndex === target.groupIndex && p.status === "active")
				const phaseLines = groupPhases
					.map((gp) => {
						const stepList =
							gp.steps.length > 0
								? `\n    Steps:\n${gp.steps.map((st) => `      ${st.index}. [${st.id}] ${st.description}`).join("\n")}`
								: "\n    No steps yet — call refine_phase to populate them."
						return `  ∥ [${gp.id}] ${gp.index}. "${gp.name}"${stepList}`
					})
					.join("\n")
				const dm = formatDecisionsAndMemories(fresh)
				const dmSection = dm ? `\n\n${dm}` : ""
				const sc = formatScopingContext(fresh)
				const scSection = sc ? `\n\n${sc}` : ""
				return toolOk(
					`Parallel group ${target.groupIndex} activated (${groupPhases.length} phases running concurrently).\nferment_id: ${fresh.id}\nparallel_group: ${target.groupIndex}\nphase_ids: ${groupPhases.map((p) => p.id).join(", ")}\n\n${phaseLines}\n\nRun all parallel phases concurrently: call refine_phase + start_step for each phase simultaneously.${scSection}${dmSection}`,
				)
			}

			const outcome = applyAndPersist(params.ferment_id, { type: "activate_phase", phaseId: target.id })
			if (!outcome.ok) return failedToolResult(outcome.error)

			// Capture git HEAD so the phase grader can diff against it later.
			const headRef = phaseServices.captureGitHead()
			if (headRef) runtime.setPhaseStartRef(params.ferment_id, target.id, headRef)

			const fresh = outcome.ferment
			const activated = fresh.phases.find((p) => p.id === target.id)
			const stepList =
				activated && activated.steps.length > 0
					? `\nSteps:\n${activated.steps.map((st) => `  ${st.index}. [${st.id}] ${st.description}`).join("\n")}`
					: "\nNo steps yet — call refine_phase to populate them."
			const dm = formatDecisionsAndMemories(fresh)
			const dmSection = dm ? `\n\n${dm}` : ""
			const sc = formatScopingContext(fresh)
			const scSection = sc ? `\n\n${sc}` : ""
			return toolOk(
				`Phase "${target.name}" activated.\nferment_id: ${fresh.id}\nphase_id: ${target.id}${stepList}${scSection}${dmSection}`,
			)
		},
	})

	pi.registerTool({
		name: "refine_phase",
		label: "Refine Phase",
		description: "Add steps to an active phase. Overwrites existing. Use the phase_id returned by activate_phase.",
		parameters: RefineParams,
		async execute(_, params) {
			// Phase resolution: exact id → name substring → active phase fallback.
			const f = runtime.getStorage().get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")
			let phase = f.phases.find((p) => p.id === params.phase_id)
			if (!phase) {
				const needle = params.phase_id.toLowerCase()
				phase = f.phases.find((p) => p.name.toLowerCase().includes(needle))
			}
			if (!phase) phase = f.phases.find((p) => p.status === "active")
			if (!phase) {
				return toolErr(
					`Phase not found. Active phases: ${
						f.phases
							.filter((p) => p.status === "active")
							.map((p) => `${p.id} (${p.name})`)
							.join(", ") || "none"
					}`,
				)
			}

			// FSM validation: refine_phase is only valid in PHASE_ACTIVE state
			const fsmError = validateFsmTransition(f, "REFINE_PHASE", { phaseId: phase.id })
			if (fsmError) return toolErr(fsmError)

			const outcome = applyAndPersist(params.ferment_id, {
				type: "refine_phase",
				phaseId: phase.id,
				steps: params.steps,
			})
			if (!outcome.ok) {
				// Rewrite phase-not-active for the LLM-friendly form expected today.
				if (outcome.error.code === "PHASE_NOT_IN_STATUS") {
					return toolErr(`Phase must be active. Current: ${outcome.error.actual}`)
				}
				return failedToolResult(outcome.error)
			}

			const refined = outcome.ferment.phases.find((p) => p.id === phase.id)
			const stepList = refined?.steps.map((st, i) => `  ${i + 1}. [step-${i + 1}] ${st.description}`).join("\n") ?? ""
			return toolOk(
				`"${phase.name}" refined with ${refined?.steps.length ?? 0} step(s).\nferment_id: ${outcome.ferment.id}\nphase_id: ${phase.id}\n${stepList}\nCall start_step with step_id to begin.`,
			)
		},
	})

	pi.registerTool({
		name: "complete_phase",
		label: "Complete Phase",
		description: `Mark phase as completed. You must produce verdicts for the three phase-scope gates below. A "flag" verdict refuses advancement.

${renderGateGuidance("complete_phase")}`,
		parameters: CompletePhaseParams,
		async execute(_, params, _signal, _onUpdate, ctx) {
			return completePhase(runtime, params, { pi, ctx }, phaseServices)
		},
	})

	pi.registerTool({
		name: "skip_phase",
		label: "Skip Phase",
		description: "Skip a phase.",
		parameters: SkipPhaseParams,
		async execute(_, params) {
			// Resolve via fuzzy first (LLM may pass partial id).
			const f = runtime.getStorage().get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")
			const phase = resolvePhase(f, params.phase_id)
			if (!phase) return toolErr("Phase not found.")

			// FSM validation: phase must be active to skip
			const fsmError = validateFsmTransition(f, "SKIP_PHASE", { phaseId: phase.id })
			if (fsmError) return toolErr(fsmError)

			const outcome = applyAndPersist(params.ferment_id, {
				type: "skip_phase",
				phaseId: phase.id,
				reason: params.reason,
			})
			if (!outcome.ok) return failedToolResult(outcome.error)
			return toolOk("Phase skipped.")
		},
	})

	pi.registerTool({
		name: "fail_phase",
		label: "Fail Phase",
		description: "Mark a phase as failed with a reason.",
		parameters: FailPhaseParams,
		async execute(_, params) {
			const f = runtime.getStorage().get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")
			const phase = resolvePhase(f, params.phase_id)
			if (!phase) return toolErr("Phase not found.")

			// FSM validation: phase must be active to fail
			const fsmError = validateFsmTransition(f, "FAIL_PHASE", { phaseId: phase.id })
			if (fsmError) return toolErr(fsmError)

			const outcome = applyAndPersist(params.ferment_id, {
				type: "fail_phase",
				phaseId: phase.id,
				reason: params.reason,
			})
			if (!outcome.ok) return failedToolResult(outcome.error)
			return toolOk(
				`Phase marked as failed: ${params.reason}. Use activate_phase to retry, skip_phase to bypass, or ask the user to run /ferment abandon if the ferment should stop.`,
			)
		},
	})
}
