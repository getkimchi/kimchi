/**
 * Phase tools: activate_ferment_phase, refine_ferment_phase, complete_ferment_phase, skip_ferment_phase, fail_ferment_phase.
 *
 * complete_ferment_phase is the most complex: it validates phase gates,
 * records evidence, handles retry escalation, and applies the continuation
 * policy at phase boundaries.
 */

import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent"
import { Markdown } from "@earendil-works/pi-tui"
import type { Static } from "typebox"
import { findFirstPlannedPhase } from "../../../ferment/engine.js"
import type { Ferment, Phase } from "../../../ferment/types.js"
import { askUser } from "../ask-user.js"
import { gradeColor, pr_bold } from "../colors.js"
import { decideContinuation } from "../continuation.js"
import { formatDecisionsAndMemories } from "../format.js"
import { validateFsmTransitionWithFerment } from "../fsm-adapter.js"
import { flaggedVerdicts, renderGateGuidance } from "../gate-registry.js"
import { validateGatesOrErr } from "../gate-validation.js"
import type { JudgeFlag } from "../judge.js"
import { onPhaseCompleted } from "../nudge.js"
import { type PhaseEvidence, captureGitHead, gatherPhaseEvidence } from "../phase-evidence.js"
import { type ProjectCheckResult, runProjectChecks, summarizeProjectChecks } from "../project-tests.js"
import { hashFlags, writeEscalationArtifact, writeReviewEvidence } from "../review-evidence.js"
import { type FermentRuntime, defaultFermentRuntime } from "../runtime.js"
import { MAX_BLOCK_RETRIES } from "../state.js"
import {
	createApplyAndPersist,
	failedToolResult,
	resolvePhase,
	toolErr,
	toolErrWithNextAction,
	toolOk,
	withNextActionHint,
} from "../tool-helpers.js"
import { FERMENT_TOOLS } from "../tool-names.js"
import { ActivateParams, CompletePhaseParams, FailPhaseParams, RefineParams, SkipPhaseParams } from "../tool-schemas.js"
import type { FermentUi, FermentUiContext } from "../ui.js"

function sendPhaseAck(pi: ExtensionAPI, text: string): void {
	void pi.sendMessage(
		{
			customType: "ferment_ack",
			content: [{ type: "text", text }],
			display: true,
			details: { text, variant: "ack" },
		},
		{ triggerTurn: false },
	)
}

function countFilesChanged(evidence: PhaseEvidence | undefined): number {
	if (!evidence?.available) return 0
	const raw = evidence.filesChanged
	if (!raw || raw === "(no changes)" || raw === "(git unavailable)") return 0
	return raw.split("\n").filter((line) => line.trim().length > 0).length
}

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

function formatManualPhaseBoundaryWait(
	ferment: Ferment,
	completedPhase: Phase,
	nextPhase: Phase,
	projectChecksLine: string,
	warnSection: string,
	reason?: string,
	summaryLine = `**Phase "${completedPhase.name}"** done.`,
): string {
	const reasonLine = reason ? `\n\n${reason}` : ""
	return (
		[
			`**Phase "${completedPhase.name}"** done.${projectChecksLine}${warnSection}`,
			`**Next:** "${nextPhase.name}".`,
			"",
			"Manual continuation policy stopped here.",
			`The ferment is paused. Do not call activate_ferment_phase yet. To continue later, the user can run /ferment resume for ferment_id "${ferment.id}", or choose Continue from /ferment list.`,
			"Do not ask a generic follow-up question in chat.",
		].join("\n") + reasonLine
	)
}

function pauseForManualPhaseBoundary(
	runtime: FermentRuntime,
	ferment: Ferment,
	completedPhase: Phase,
	nextPhase: Phase,
	projectChecksLine: string,
	warnSection: string,
	copy: {
		summaryLine?: string
	} = {},
): ToolResult {
	const summaryLine = copy.summaryLine ?? `Phase "${completedPhase.name}" done.`
	const pauseOutcome = createApplyAndPersist(runtime)(ferment.id, { type: "pause" })
	if (pauseOutcome.ok) {
		runtime.setActive(pauseOutcome.ferment)
		return toolOk(
			formatManualPhaseBoundaryWait(
				pauseOutcome.ferment,
				completedPhase,
				nextPhase,
				projectChecksLine,
				warnSection,
				undefined,
				summaryLine,
			),
		)
	}
	return toolOk(
		formatManualPhaseBoundaryWait(
			ferment,
			completedPhase,
			nextPhase,
			projectChecksLine,
			warnSection,
			`Could not pause automatically: ${pauseOutcome.error.message}`,
			summaryLine,
		),
	)
}

function formatManualPhaseBoundaryContinue(
	ferment: Ferment,
	completedPhase: Phase,
	nextPhase: Phase,
	projectChecksLine: string,
	warnSection: string,
	summaryLine = `**Phase "${completedPhase.name}"** done.`,
): string {
	return withNextActionHint(
		[
			`**Phase "${completedPhase.name}"** done.${projectChecksLine}${warnSection}`,
			`**Next:** "${nextPhase.name}".`,
			"",
			"User chose to continue to the next phase.",
		].join("\n"),
		ferment,
	)
}

async function maybeCompleteManualPhaseBoundary(
	runtime: FermentRuntime,
	ferment: Ferment,
	completedPhase: Phase,
	projectChecksLine: string,
	warnSection: string,
	ctx?: PhaseUiContext,
	copy?: Parameters<typeof pauseForManualPhaseBoundary>[6],
): Promise<ToolResult | undefined> {
	const decision = decideContinuation(ferment, runtime.getContinuationPolicy())
	if (decision.type !== "wait_manual_boundary") return undefined
	const nextPhase = ferment.phases.find((phase) => phase.id === decision.action.phaseId)
	if (!nextPhase) return undefined
	const summaryLine = copy?.summaryLine ?? `Phase "${completedPhase.name}" done.`
	if (ctx?.ui?.select) {
		const choice = await ctx.ui.select(`${summaryLine}\nContinue "${ferment.name}" to "${nextPhase.name}"?`, [
			"Continue to next phase",
			"Pause here",
		])
		if (choice === "Continue to next phase") {
			return toolOk(
				formatManualPhaseBoundaryContinue(
					ferment,
					completedPhase,
					nextPhase,
					projectChecksLine,
					warnSection,
					summaryLine,
				),
			)
		}
	}
	return pauseForManualPhaseBoundary(runtime, ferment, completedPhase, nextPhase, projectChecksLine, warnSection, copy)
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

	// FSM validation: complete_ferment_phase requires all phases to be terminal
	const fsmError = validateFsmTransition(f, "COMPLETE_PHASE", { phaseId: phase.id })
	if (fsmError) return toolErrWithNextAction(fsmError, f)

	// Step 2a: validate gate coverage + per-verdict shape. Phase-scope is the
	// one tool that does NOT short-circuit on a flag — flags feed the
	// retry/escalation pipeline below via flagsFromGateVerdicts. Coverage
	// failure or malformed shape still return a tool error immediately.
	const gateError = validateGatesOrErr(params.gates, {
		turn: "complete_ferment_phase",
		flagPolicy: "coverage-only",
	})
	if (gateError) return gateError

	// Capture the phase shape for evidence/review artifacts.
	const stepSummariesText = phase.steps.map((st) => `  ${st.index}. ${st.description} [${st.status}]`).join("\n")

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
		gateVerdicts: params.gates,
	})

	// Step 3: if either the reviewer or the project checks raised block flags,
	// refuse phase advancement. This is the self-heal loop: agent gets
	// concrete redirects, fixes the work, and calls complete_ferment_phase again.
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

			const reason = sameFailureRepeated
				? "same block flags repeated — no progress between attempts"
				: `still blocking after ${MAX_BLOCK_RETRIES} retries`
			const reviewTitle = [
				`Phase ${phase.index}: "${phase.name}" — reviewer ${reason}`,
				"",
				"Block flags:",
				...blockFlags.map((fl) => `  - ${fl.problem}`),
			].join("\n")
			const escalationResponse = await askUser(
				reviewTitle,
				[
					{ id: "override", label: "Override and proceed (mark phase done)" },
					{ id: "pause", label: "Pause ferment for manual fix" },
					{ id: "abandon", label: "Abandon ferment" },
				],
				{ ferment: f, pi, ctx, runtime },
			)

			if (!escalationResponse.failed && escalationResponse.choice === "override") {
				runtime.clearBlockRetry(params.ferment_id, phase.id)
				// fall through to "advance phase" path below
			} else if (!escalationResponse.failed && escalationResponse.choice === "abandon") {
				const abandonOutcome = applyAndPersist(params.ferment_id, {
					type: "abandon",
					reason: "user abandoned after block retries exhausted",
				})
				if (abandonOutcome.ok) runtime.setActive(abandonOutcome.ferment)
				return toolErr(`Phase "${phase.name}" abandoned at user request after ${MAX_BLOCK_RETRIES} block retries.`)
			} else {
				// Default to pause: explicit pause choice, failed routing (no UI
				// + not one-shot), or user-cancelled. The escalation artifact on
				// disk is the recovery surface.
				const pauseOutcome = applyAndPersist(params.ferment_id, { type: "pause" })
				if (pauseOutcome.ok) {
					runtime.setActive(pauseOutcome.ferment)
				}
				const reasonNote = sameFailureRepeated
					? "the reviewer raised the same block flags twice in a row — agent made no progress against them"
					: `the reviewer raised block flags ${retry - 1} times in a row and the self-heal loop did not converge`
				return toolErr(
					`Phase "${phase.name}" cannot complete — ${reasonNote}.\n\n${flagLines}${warnLines}\n\nFerment paused. An escalation artifact was written under .kimchi/ferments/${f.id}/escalations/phase-${phase.id}.json. The user must intervene before any further ferment tool calls.`,
				)
			}
		} else {
			// Within retry budget — surface flags and refuse advancement. The
			// redirect text lives in the tool error response below; that's
			// the agent's recovery surface for the next attempt.
			const projectChecksNote = projectChecks.discovered ? `\n${projectCheckSummary}` : ""
			return toolErr(
				`**Phase "${phase.name}"** cannot complete — reviewer raised ${blockFlags.length} block flag(s) (retry ${retry}/${MAX_BLOCK_RETRIES}).${projectChecksNote}\n\n${flagLines}${warnLines}\n\nFix the issues above and call complete_ferment_phase again with an updated summary.`,
			)
		}
	}

	// Step 4: no block flags. Transition phase to completed.
	// Capture block retry count before clearing — the counter is reset on the
	// line below and won't be readable afterwards.
	const blockRetriesForTelemetry = reviewAttemptForLog - 1
	const completeOutcome = applyAndPersist(params.ferment_id, {
		type: "complete_phase",
		phaseId: phase.id,
		summary: params.summary,
		grade: {
			grade: derivedGrade as import("../../../ferment/types.js").Grade,
			rationale,
			gradedAt: runtime.nowIso(),
		},
		blockRetries: blockRetriesForTelemetry,
	})
	if (!completeOutcome.ok) return failedToolResult(completeOutcome.error, f)

	// Step 3a: clear the block-retry counter — phase advanced cleanly.
	runtime.clearBlockRetry(params.ferment_id, phase.id)

	// Step 4: no per-phase grading. The journey-grade judge at
	// complete_ferment is the only place a letter grade is assigned, and it
	// reads the on-disk review-evidence sidecar (which already captures
	// derivedGrade + the raw F-gate verdicts written above) as input. So we
	// skip set_phase_grade entirely on the new path.

	services.onPhaseCompleted(runtime)
	const fresh = completeOutcome.ferment

	// Visual ack mirrors the step ✓ breadcrumb in steps.ts. The grade letter is
	// the deterministic derivedGrade (A/B/F) from gate verdicts + project
	// checks (post-#230 no LLM judge per phase), colorized via gradeColor for
	// terminal output.
	const filesCount = countFilesChanged(evidence)
	const summaryLines = [`Phase ${phase.index} ✓  Grade ${gradeColor(derivedGrade)} — ${rationale}`]
	if (filesCount > 0) summaryLines.push(`${filesCount} file${filesCount === 1 ? "" : "s"} touched`)
	sendPhaseAck(pi, summaryLines.join("\n"))
	const warnSection =
		warnFlags.length > 0
			? `\n\nAdvisory warnings carried over:\n${warnFlags.map((fl) => `  ⚠ ${fl.problem} — ${fl.redirect}`).join("\n")}`
			: ""
	const projectChecksLine = projectChecks.discovered ? `\n${projectCheckSummary}` : ""

	const manualBoundary = await maybeCompleteManualPhaseBoundary(
		runtime,
		fresh,
		phase,
		projectChecksLine,
		warnSection,
		ctx,
	)
	if (manualBoundary) return manualBoundary

	const continuation = decideContinuation(fresh, runtime.getContinuationPolicy())
	const activateAction =
		continuation.type === "continue" && continuation.action.kind === "activate_phase" ? continuation.action : undefined
	const nextPhase = activateAction ? fresh.phases.find((p) => p.id === activateAction.phaseId) : undefined

	if (!nextPhase) {
		return toolOk(
			withNextActionHint(
				`**Phase "${phase.name}"** done.\n\n## Summary${projectChecksLine}${warnSection}${
					continuation.type === "idle" && continuation.action?.kind === "complete_ferment"
						? "\n**All phases terminal.**"
						: ""
				}`,
				fresh,
			),
		)
	}

	return toolOk(
		withNextActionHint(
			`**Phase "${phase.name}"** done.${projectChecksLine}${warnSection}\n**Next:** "${nextPhase.name}".`,
			fresh,
		),
	)
}

export function registerPhaseTools(pi: ExtensionAPI, runtime: FermentRuntime = defaultFermentRuntime): void {
	const applyAndPersist = createApplyAndPersist(runtime)
	const phaseServices: PhaseHandlerServices = {
		...defaultPhaseHandlerServices,
		onPhaseCompleted: () => onPhaseCompleted(runtime),
	}
	pi.registerTool({
		name: FERMENT_TOOLS.ACTIVATE_PHASE,
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
			if (!target) return toolErrWithNextAction("No planned or failed phases to activate.", f)

			// FSM validation: ensure phase activation is allowed
			const fsmError = validateFsmTransition(f, "ACTIVATE_PHASE", { phaseId: target.id })
			if (fsmError) return toolErrWithNextAction(fsmError, f)

			// Detect parallel group — activate all siblings at once
			if (target.groupIndex !== undefined) {
				const outcome = applyAndPersist(params.ferment_id, {
					type: "activate_phase_group",
					groupIndex: target.groupIndex,
				})
				if (!outcome.ok) return failedToolResult(outcome.error, f)

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
								: "\n    No steps yet — call refine_ferment_phase to populate them."
						return `  ∥ [${gp.id}] ${gp.index}. "${gp.name}"${stepList}`
					})
					.join("\n")
				const dm = formatDecisionsAndMemories(fresh)
				const dmSection = dm ? `\n\n${dm}` : ""
				return toolOk(
					withNextActionHint(
						`Parallel group ${target.groupIndex} activated (${groupPhases.length} phases running concurrently).\nferment_id: ${fresh.id}\nparallel_group: ${target.groupIndex}\nphase_ids: ${groupPhases.map((p) => p.id).join(", ")}\n\n${phaseLines}\n\nRun all parallel phases concurrently: call refine_ferment_phase + start_ferment_step for each phase simultaneously.${dmSection}`,
						fresh,
					),
				)
			}

			const outcome = applyAndPersist(params.ferment_id, { type: "activate_phase", phaseId: target.id })
			if (!outcome.ok) return failedToolResult(outcome.error, f)

			// Capture git HEAD so the phase grader can diff against it later.
			const headRef = phaseServices.captureGitHead()
			if (headRef) runtime.setPhaseStartRef(params.ferment_id, target.id, headRef)

			const fresh = outcome.ferment
			const activated = fresh.phases.find((p) => p.id === target.id)
			const stepList =
				activated && activated.steps.length > 0
					? `\nSteps:\n${activated.steps.map((st) => `  ${st.index}. [${st.id}] ${st.description}`).join("\n")}`
					: "\nNo steps yet — call refine_ferment_phase to populate them."
			const dm = formatDecisionsAndMemories(fresh)
			const dmSection = dm ? `\n\n${dm}` : ""
			return toolOk(
				withNextActionHint(
					`Phase "${target.name}" activated.\nferment_id: ${fresh.id}\nphase_id: ${target.id}${stepList}${dmSection}`,
					fresh,
				),
			)
		},
	})

	pi.registerTool({
		name: FERMENT_TOOLS.REFINE_PHASE,
		label: "Refine Phase",
		description:
			"Add steps to an active phase. Overwrites existing. Use the phase_id returned by activate_ferment_phase.",
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

			// FSM validation: refine_ferment_phase is only valid in PHASE_ACTIVE state
			const fsmError = validateFsmTransition(f, "REFINE_PHASE", { phaseId: phase.id })
			if (fsmError) return toolErrWithNextAction(fsmError, f)

			const outcome = applyAndPersist(params.ferment_id, {
				type: "refine_phase",
				phaseId: phase.id,
				steps: params.steps,
			})
			if (!outcome.ok) {
				// Rewrite phase-not-active for the LLM-friendly form expected today.
				if (outcome.error.code === "PHASE_NOT_IN_STATUS") {
					return toolErrWithNextAction(`Phase must be active. Current: ${outcome.error.actual}`, f)
				}
				return failedToolResult(outcome.error, f)
			}

			const refined = outcome.ferment.phases.find((p) => p.id === phase.id)
			const stepList = refined?.steps.map((st, i) => `  ${i + 1}. [step-${i + 1}] ${st.description}`).join("\n") ?? ""
			return toolOk(
				withNextActionHint(
					`"${phase.name}" refined with ${refined?.steps.length ?? 0} step(s).\nferment_id: ${outcome.ferment.id}\nphase_id: ${phase.id}\n${stepList}`,
					outcome.ferment,
				),
			)
		},
	})

	pi.registerTool({
		name: FERMENT_TOOLS.COMPLETE_PHASE,
		label: "Complete Phase",
		description: `Mark phase as completed. You must produce verdicts for the three phase-scope gates below. A "flag" verdict refuses advancement.

${renderGateGuidance("complete_ferment_phase")}`,
		parameters: CompletePhaseParams,
		renderResult(result) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : ""
			return new Markdown(text, 1, 0, getMarkdownTheme())
		},
		async execute(_, params, _signal, _onUpdate, ctx) {
			return completePhase(runtime, params, { pi, ctx }, phaseServices)
		},
	})

	pi.registerTool({
		name: FERMENT_TOOLS.SKIP_PHASE,
		label: "Skip Phase",
		description: "Skip a phase.",
		parameters: SkipPhaseParams,
		async execute(_, params, _signal, _onUpdate, ctx) {
			// Resolve via fuzzy first (LLM may pass partial id).
			const f = runtime.getStorage().get(params.ferment_id)
			if (!f) return toolErr("Ferment not found.")
			const phase = resolvePhase(f, params.phase_id)
			if (!phase) return toolErr("Phase not found.")

			// FSM validation: phase must be active to skip
			const fsmError = validateFsmTransition(f, "SKIP_PHASE", { phaseId: phase.id })
			if (fsmError) return toolErrWithNextAction(fsmError, f)

			const outcome = applyAndPersist(params.ferment_id, {
				type: "skip_phase",
				phaseId: phase.id,
				reason: params.reason,
			})
			if (!outcome.ok) return failedToolResult(outcome.error, f)

			const manualBoundary = await maybeCompleteManualPhaseBoundary(runtime, outcome.ferment, phase, "", "", ctx, {
				summaryLine: `Phase "${phase.name}" skipped.`,
			})
			if (manualBoundary) return manualBoundary

			return toolOk(withNextActionHint("Phase skipped.", outcome.ferment))
		},
	})

	pi.registerTool({
		name: FERMENT_TOOLS.FAIL_PHASE,
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
			if (fsmError) return toolErrWithNextAction(fsmError, f)

			const outcome = applyAndPersist(params.ferment_id, {
				type: "fail_phase",
				phaseId: phase.id,
				reason: params.reason,
			})
			if (!outcome.ok) return failedToolResult(outcome.error, f)
			return toolOk(
				withNextActionHint(
					`Phase marked as failed: ${params.reason}. Use activate_ferment_phase to retry, skip_ferment_phase to bypass, or ask the user to run /ferment abandon if the ferment should stop.`,
					outcome.ferment,
				),
			)
		},
	})
}
