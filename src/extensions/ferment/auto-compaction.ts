/**
 * Ferment auto-compaction.
 *
 * After every successful `complete_ferment_step` or `complete_ferment_phase`,
 * the tool handler records a pending compaction request in `state.ts`.
 * The `turn_end` and `agent_end` hooks call `maybeTriggerFermentCompaction` to:
 *   1. Drain ready (non-in-flight) pending entries from the map.
 *   2. Build custom instructions highlighting the ferment plan and stage.
 *      On the inline path, skip compaction (but still deliver the handoff)
 *      when the estimated context is below the minimum-size gate
 *      (`StageCompactionOptions.minContextTokens`) — small contexts cost a
 *      full summarization call and save nothing.
 *   3. Append a hidden `ferment_stage_handoff` session entry so the next stage
 *      has all context it needs to resume cleanly. On the inline path this
 *      happens BEFORE compaction: the handoff is the newest valid cut point,
 *      so the compaction keeps summary + handoff for the next stage.
 *   4. Fire `ctx.inlineCompact()` when available, or `ctx.compact()` as a legacy
 *      fallback (which appends the handoff on completion instead), to summarise
 *      the session.
 *
 * In-flight tracking lives in `state.ts` (via `FermentRuntime`) so it is
 * scoped to the runtime instance and resets on session_start, not leaked across
 * test runs.
 *
 * Failures warn via `ctx.ui.notify` and never block the pipeline.
 */

import type { ModelThinkingLevel } from "@earendil-works/pi-ai"
import {
	buildSessionContext,
	type CompactionResult,
	calculateContextTokens,
	type ExtensionAPI,
	type ExtensionContext,
	getLastAssistantUsage,
} from "@earendil-works/pi-coding-agent"
import { determineNextAction } from "../../ferment/engine.js"
import type { Ferment, Phase, Step } from "../../ferment/types.js"
import { getCompactionEnabled } from "../../settings-watcher.js"
import { isToolCallInFlight } from "../../tool-call-in-flight.js"
import { COMPACTION_RESERVE_TOKENS } from "../compaction-thresholds.js"
import { getModelRoles, splitModelRef } from "../orchestration/model-roles.js"
import { isStaleCtxError } from "../stale-ctx.js"
import type { FermentRuntime } from "./runtime.js"
import { safeSendMessage, tryPiAction } from "./safe-send.js"
import { scheduleNextFermentAction } from "./scheduler.js"
import type { PendingCompaction } from "./state.js"

// ─── Public types ─────────────────────────────────────────────────────────────

/** Tunables for stage-boundary compaction. Callers may override per call;
 *  everything defaults to `DEFAULT_STAGE_COMPACTION_OPTIONS`. */
export interface StageCompactionOptions {
	/** Skip stage compaction when the estimated context is below this many tokens. */
	minContextTokens: number
	/** Never keep fewer recent tokens than this on a forced stage cut. */
	minKeepRecentTokens: number
	/** Fraction of the model's context window kept as recent tokens (before the floor). */
	keepRecentWindowFraction: number
	/** Thinking level for the summarization call. */
	thinkingLevel: ModelThinkingLevel
}

export const DEFAULT_STAGE_COMPACTION_OPTIONS: Readonly<StageCompactionOptions> = {
	// Below this, the multi-minute summarization call saves almost nothing.
	// Compactions firing at a median of ~30k tokens consume 20–40% of session
	// wall time, converting passing tasks into agent timeouts. The next stage
	// boundary re-checks, so skipped stages compact once the context has grown.
	minContextTokens: 50_000,
	minKeepRecentTokens: 20_000,
	keepRecentWindowFraction: 0.05,
	// Compaction is pure summarization and never benefits from extended thinking.
	thinkingLevel: "off",
}

export interface FermentHandoffDetails {
	fermentName: string
	fermentGoal?: string
	successCriteria?: string[]
	activePhaseName: string
	activePhaseGoal: string
	nextStepDescription?: string
	nextPhaseName?: string
	nextPhaseGoal?: string
	completedStepSummary?: string
	completedPhaseSummary?: string
	/** Number of tokens in the session before compaction was triggered (from CompactionResult.tokensBefore) */
	compactionTokensBefore?: number
	/** Why compaction produced no result (skipped or failed). Absent on success.
	 *  Persisted so headless runs (where ctx.ui.notify is a no-op) remain diagnosable
	 *  from session files alone. */
	compactionError?: string
}

type HandoffContent = Array<{ type: "text"; text: string }>
type InlineHandoffSessionManager = {
	appendCustomMessageEntry?: (
		customType: string,
		content: HandoffContent,
		display: boolean,
		details?: FermentHandoffDetails,
	) => unknown
}

/** Return the token count at which we should trigger auto-compaction.
 *  Clamped to zero so tiny context windows never produce a negative threshold
 *  that would spuriously match any non-negative token count. */
function compactionThreshold(contextWindow: number): number {
	return Math.max(0, contextWindow - COMPACTION_RESERVE_TOKENS)
}

/** Best-effort estimate of the current context size: the token usage reported
 *  by the last assistant message — the same signal upstream's `shouldCompact`
 *  uses. Returns 0 when unknown (fresh session, no assistant turn yet), which
 *  callers treat as "too small to compact". */
function estimateSessionContextTokens(ctx: ExtensionContext): number {
	try {
		const usage = getLastAssistantUsage(ctx.sessionManager?.getEntries?.() ?? [])
		return usage ? calculateContextTokens(usage) : 0
	} catch {
		return 0
	}
}

function readFermentOneshotFlag(pi: ExtensionAPI): boolean | undefined {
	let isOneShot: boolean | undefined
	tryPiAction(() => {
		isOneShot = pi.getFlag?.("ferment-oneshot") === true
	})
	return isOneShot
}

/**
 * Best-effort read of the session's project-trust decision. Passed to
 * getCompactionEnabled so project-scope settings apply exactly when pi's own
 * session applies them. Undefined (stale ctx, sloppy mock) leaves the reader's
 * last-synced trust untouched. Matches the tryPiAction idiom: stale-ctx errors
 * are routine (post-shutdown/reload) and stay silent; anything else is traced
 * so a broken trust accessor doesn't fail invisibly.
 */
function readProjectTrust(ctx: ExtensionContext): boolean | undefined {
	try {
		return ctx.isProjectTrusted?.()
	} catch (err) {
		if (!isStaleCtxError(err)) {
			console.warn("[ferment] failed to read project trust:", err)
		}
		return undefined
	}
}

// ─── In-flight tool-call guard ────────────────────────────────────────────────

export { isToolCallInFlight } from "../../tool-call-in-flight.js"

/**
 * Thin wrapper: read the live session entries from `ctx.sessionManager` and
 * delegate to `isToolCallInFlight`. Returns false on any access failure so a
 * broken/missing sessionManager never blocks compaction spuriously — the
 * phase-1 sanitizer remains the hard guarantee.
 */
export function isToolCallInFlightInSession(ctx: ExtensionContext): boolean {
	try {
		const entries = ctx?.sessionManager?.getEntries?.() ?? []
		const leafId = ctx.sessionManager.getLeafId()
		return isToolCallInFlight(buildSessionContext(entries, leafId).messages)
	} catch {
		return false
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a human-readable description of the next action from `determineNextAction`.
 * Returns undefined when no next action is found (ferment complete/abandoned).
 */
function buildNextActionDescription(
	ferment: Ferment,
): { nextStepDescription?: string; nextPhaseName?: string; nextPhaseGoal?: string } | undefined {
	const action = determineNextAction(ferment)
	if (!action) return undefined

	switch (action.kind) {
		case "start_step":
		case "complete_step":
		case "verify_step": {
			const phase = ferment.phases.find((p) => p.id === action.phaseId)
			const step = phase?.steps.find((s) => s.id === action.stepId)
			return {
				nextStepDescription: step ? `Step ${step.index}: ${step.description}` : action.stepId,
				nextPhaseName: phase?.name,
				nextPhaseGoal: phase?.goal,
			}
		}
		case "activate_phase": {
			const phase = ferment.phases.find((p) => p.id === action.phaseId)
			return {
				nextPhaseName: phase?.name ?? action.phaseId,
				nextPhaseGoal: phase?.goal,
			}
		}
		case "complete_phase": {
			const phase = ferment.phases.find((p) => p.id === action.phaseId)
			return {
				nextPhaseName: phase?.name,
				nextPhaseGoal: phase?.goal,
			}
		}
		default:
			return undefined
	}
}

/** Find the step that just completed (from the pending compaction's stepId). */
function findCompletedStep(ferment: Ferment, pending: PendingCompaction): Step | undefined {
	if (!pending.stepId) return undefined
	return findStepById(ferment, pending.phaseId, pending.stepId)
}

/** Find the phase that just completed (from the pending compaction's phaseId). */
function findCompletedPhase(ferment: Ferment, pending: PendingCompaction): Phase | undefined {
	return findPhaseById(ferment, pending.phaseId)
}

function findPhaseById(ferment: Ferment, phaseId: string): Phase | undefined {
	return ferment.phases.find((p) => p.id === phaseId)
}

function findStepById(ferment: Ferment, phaseId: string, stepId: string): Step | undefined {
	return findPhaseById(ferment, phaseId)?.steps.find((s) => s.id === stepId)
}

function findActivePhaseAndStep(ferment: Ferment): { phase?: Phase; step?: Step } {
	const phase = ferment.phases.find((p) => p.status === "active")
	const step = phase?.steps.find((s) => s.status === "running")
	return { phase, step }
}

type RegisteredCompactorModel = ReturnType<NonNullable<ExtensionContext["modelRegistry"]>["find"]>

interface CompactorModelResolution {
	model?: RegisteredCompactorModel
	fallbackWarning?: string
}

/** Resolve the optional compactor override; missing model means use the session model. */
function resolveCompactorModel(ctx: ExtensionContext): CompactorModelResolution {
	try {
		const ref = getModelRoles().compactor
		if (!ref) return {}
		const parsed = splitModelRef(ref)
		if (!parsed) {
			return {
				fallbackWarning: `Compactor model role "${ref}" is not a valid provider/model reference — stage compaction falls back to the session model`,
			}
		}
		const model = ctx.modelRegistry?.find(parsed.provider, parsed.modelId)
		if (!model) {
			return {
				fallbackWarning: `Compactor model role "${ref}" is not in the model registry — stage compaction falls back to the session model`,
			}
		}
		return { model }
	} catch {
		return {}
	}
}

/** Build the custom instructions string passed to compaction. */
export function buildCustomInstructions(ferment: Ferment, pending: PendingCompaction): string {
	const completedPhase = findCompletedPhase(ferment, pending)
	const completedStep = findCompletedStep(ferment, pending)
	const nextAction = buildNextActionDescription(ferment)

	const lines: string[] = ["Preserve ferment plan details in the summary:"]

	lines.push(`- Ferment: ${ferment.name}${ferment.goal ? ` — ${ferment.goal}` : ""}`)

	if (ferment.successCriteria && ferment.successCriteria.length > 0) {
		lines.push(`- Success criteria: ${ferment.successCriteria.join("; ")}`)
	}

	// For step completions: show the phase that is still active.
	// For phase completions: show the just-completed phase as "completed", then
	// show the next active phase (if any) as the current context.
	if (pending.kind === "step") {
		const activePhase = ferment.phases.find((p) => p.status === "active") ?? completedPhase
		if (activePhase) {
			lines.push(`- Active phase: ${activePhase.name} — ${activePhase.goal}`)
		}
		if (completedStep) {
			lines.push(
				`- Completed step: ${completedStep.description}${completedStep.summary ? ` (${completedStep.summary})` : ""}`,
			)
		}
	} else {
		// kind === "phase"
		if (completedPhase) {
			lines.push(
				`- Completed phase: ${completedPhase.name}${completedPhase.summary ? ` (${completedPhase.summary})` : ""}`,
			)
		}
		const nextActivePhase = ferment.phases.find((p) => p.status === "active")
		if (nextActivePhase) {
			lines.push(`- Next active phase: ${nextActivePhase.name} — ${nextActivePhase.goal}`)
		}
	}

	if (nextAction?.nextStepDescription) {
		lines.push(`- Next up: ${nextAction.nextStepDescription}`)
	} else if (nextAction?.nextPhaseName) {
		lines.push(`- Next up: Phase "${nextAction.nextPhaseName}" — ${nextAction.nextPhaseGoal ?? "goal TBD"}`)
	} else {
		lines.push("- Next up: No further lifecycle action — ferment is terminal")
	}

	return lines.join("\n")
}

/** Build custom instructions for a mid-turn compaction that must resume an
 *  in-progress step. Emphasises the active phase/step so the summary preserves
 *  the exact work being done when the context filled. */
export function buildMidTurnCustomInstructions(
	ferment: Ferment,
	phase: Phase | undefined,
	step: Step | undefined,
): string {
	const lines: string[] = [
		"The context filled while a ferment step was in progress. Preserve the plan and resume the step:",
	]

	lines.push(`- Ferment: ${ferment.name}${ferment.goal ? ` — ${ferment.goal}` : ""}`)

	if (ferment.successCriteria && ferment.successCriteria.length > 0) {
		lines.push(`- Success criteria: ${ferment.successCriteria.join("; ")}`)
	}

	if (phase) {
		lines.push(`- Active phase: ${phase.name} — ${phase.goal}`)
	}

	if (step) {
		lines.push(`- In-progress step: ${step.description}${step.summary ? ` (${step.summary})` : ""}`)
	}

	lines.push(
		"- On resume: continue the in-progress step from where it left off. Do NOT restart it or switch to a different step.",
	)

	return lines.join("\n")
}

export function buildHandoffDetails(
	result: CompactionResult | undefined,
	ferment: Ferment,
	pending: PendingCompaction,
): FermentHandoffDetails {
	const completedPhase = findCompletedPhase(ferment, pending)
	const completedStep = findCompletedStep(ferment, pending)
	const nextAction = buildNextActionDescription(ferment)
	const activePhase = ferment.phases.find((p) => p.status === "active") ?? completedPhase

	return {
		fermentName: ferment.name,
		fermentGoal: ferment.goal,
		successCriteria: ferment.successCriteria,
		activePhaseName: activePhase?.name ?? "unknown",
		activePhaseGoal: activePhase?.goal ?? "",
		nextStepDescription: nextAction?.nextStepDescription,
		nextPhaseName: nextAction?.nextPhaseName,
		nextPhaseGoal: nextAction?.nextPhaseGoal,
		completedStepSummary: completedStep?.summary,
		completedPhaseSummary: completedPhase?.summary,
		compactionTokensBefore: result?.tokensBefore,
	}
}

// Error messages that upstream treats as routine "no-op" compaction outcomes.
// Kept as a single source of truth so the two compaction paths stay consistent.
const EXPECTED_COMPACTION_ERROR_MESSAGES = [
	"too small",
	"Already compacted",
	"Compaction cancelled",
	"no summarizable messages",
]

function isExpectedCompactionError(error: Error): boolean {
	return EXPECTED_COMPACTION_ERROR_MESSAGES.some((message) => error.message.includes(message))
}

/**
 * Fire `ctx.inlineCompact` with the shared ferment compaction options (compactor
 * model override, thinking level, keepRecent floor, force). Assumes the caller
 * has already verified `ctx.inlineCompact` is a function.
 *
 * Never throws: returns `{ result }` on success or `{ error }` on failure. The
 * caller owns in-flight bookkeeping, breadcrumbs, and continuation scheduling so
 * the stage-boundary and mid-turn paths stay free to diverge on those while
 * sharing the one call that must not drift — the `inlineCompact` invocation.
 */
async function invokeInlineCompaction(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	customInstructions: string,
	options: StageCompactionOptions,
): Promise<{ result?: CompactionResult; error?: Error }> {
	const inlineCompact = ctx.inlineCompact
	if (typeof inlineCompact !== "function") {
		return { error: new Error("inlineCompact unavailable") }
	}
	const compactorModel = resolveCompactorModel(ctx)
	if (compactorModel.fallbackWarning) {
		tryPiAction(() => {
			pi.appendEntry("ferment_breadcrumb", { text: compactorModel.fallbackWarning })
		})
	}
	try {
		const result = await inlineCompact({
			customInstructions,
			// Optional override so compaction's summarization call can run on a
			// separate (e.g. cheaper) model instead of the session's active one.
			// Undefined when unconfigured — inlineCompact falls back to the session
			// model exactly as before.
			model: compactorModel.model,
			thinkingLevel: options.thinkingLevel,
			keepRecentTokens: Math.max(
				options.minKeepRecentTokens,
				Math.floor((ctx.model?.contextWindow ?? 0) * options.keepRecentWindowFraction),
			),
			// Ferment compaction is event-driven (stage boundary / mid-turn overrun),
			// not threshold driven. Force keeps automated runs compacting proactively.
			force: true,
		})
		return { result }
	} catch (error) {
		return { error: error instanceof Error ? error : new Error(String(error)) }
	}
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Check for pending compaction requests and fire compaction for each ready one.
 *
 * Called from both `turn_end` (between phases in automated-continuation runs)
 * and `agent_end` (catch-all after the run finishes). The in-flight guard in
 * `runtime` prevents double-fire for ferments whose previous compaction is still
 * running — their pending entry is left in the map and retried on the next tick.
 *
 * @param pi      - ExtensionAPI (for sendMessage and events)
 * @param ctx     - ExtensionContext (for compact, ui.notify)
 * @param runtime - FermentRuntime (for storage, active-id, pending-compaction state)
 */
export async function maybeTriggerFermentCompaction(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: FermentRuntime,
	options: StageCompactionOptions = DEFAULT_STAGE_COMPACTION_OPTIONS,
): Promise<boolean> {
	const hasInlineCompact = typeof ctx.inlineCompact === "function"
	const isOneShot = readFermentOneshotFlag(pi)
	if (isOneShot === undefined) return false
	if (isOneShot && !hasInlineCompact) return false

	// /settings Auto-compact toggle (settings.json compaction.enabled).
	if (!getCompactionEnabled(readProjectTrust(ctx))) return false

	// Root-cause guard: defer compaction while a tool call is in flight (the
	// trailing assistant toolCall has no matching toolResult yet). Compacting
	// now would summarise away the toolCall and orphan the toolResult appended
	// later. Leave the pending entry in the map for a later turn_end / agent_end
	// to pick up once the pair completes.
	if (isToolCallInFlightInSession(ctx)) return false

	// drainPendingCompactions() skips in-flight ferments — their entries stay in
	// the map for the next turn_end / agent_end to pick up.
	const ready = runtime.drainPendingCompactions()
	if (ready.length === 0) return false

	let didWork = false
	for (const pending of ready) {
		didWork = (await triggerCompactionForPending(pi, ctx, runtime, pending, options)) || didWork
	}
	return didWork
}

async function triggerCompactionForPending(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: FermentRuntime,
	pending: PendingCompaction,
	options: StageCompactionOptions,
): Promise<boolean> {
	const { fermentId } = pending

	// Mark in-flight via runtime so the guard is scoped to this runtime instance
	// (resets at session_start, not leaked across test runs).
	runtime.markCompactionInFlight(fermentId)

	// Reload the ferment from disk — the in-memory copy may be stale.
	const fermentMaybe = runtime.getStorage().get(fermentId)
	if (!fermentMaybe) {
		runtime.clearCompactionInFlight(fermentId)
		return false
	}
	// Captured after the guard so the non-null type is visible inside closures.
	const ferment: Ferment = fermentMaybe

	const customInstructions = buildCustomInstructions(ferment, pending)

	/** Append the hidden handoff entry so the next stage always receives
	 *  plan + stage context, even when compaction is skipped (session too
	 *  small, already compacted, no model, etc.). */
	function appendHandoffEntry(result?: CompactionResult, errorMessage?: string, synchronous = false): void {
		const handoff = buildHandoffDetails(result, ferment, pending)
		if (!result && errorMessage) {
			handoff.compactionError = errorMessage
		}
		const content: HandoffContent = [{ type: "text", text: JSON.stringify(handoff) }]
		const directAppend = synchronous
			? (ctx.sessionManager as InlineHandoffSessionManager | undefined)?.appendCustomMessageEntry
			: undefined
		if (directAppend) {
			directAppend.call(ctx.sessionManager, "ferment_stage_handoff", content, false, handoff)
			return
		}
		if (synchronous) {
			// The direct-append path depends on an undocumented upstream method
			// (appendCustomMessageEntry is a write method on what the public types
			// call ReadonlySessionManager). If upstream renames or removes it, the
			// handoff degrades to the async path below, is NOT in the branch at
			// prepare time, and the forced compaction that expected it as a cut
			// point silently no-ops — the exact regression that once spanned whole
			// benchmark runs. Make that degradation loud in the session file.
			tryPiAction(() => {
				pi.appendEntry("ferment_breadcrumb", {
					text: "Stage handoff direct-append unavailable (sessionManager.appendCustomMessageEntry missing) — handoff will append asynchronously and the forced stage compaction may no-op",
				})
			})
		}
		safeSendMessage(
			pi,
			{
				customType: "ferment_stage_handoff",
				content,
				display: false,
				details: handoff,
			},
			{ triggerTurn: false },
		)
	}

	function scheduleContinuationBestEffort(): void {
		// After compaction the LLM's previous next-action reasoning was discarded
		// with the old history, so steer the next action into the current drain
		// path instead of queueing a follow-up that can go stale.
		try {
			const freshFerment = runtime.getStorage().get(fermentId)
			if (freshFerment && (freshFerment.status === "running" || freshFerment.status === "planned")) {
				runtime.setActive(freshFerment)
				scheduleNextFermentAction(pi, freshFerment, runtime, {
					tag: "Auto-compaction continuation",
					deliverAs: "steer",
				})
			}
		} catch {
			// Best-effort: scheduler errors must not propagate from compaction.
		}
	}

	function finishCompaction(result: CompactionResult): void {
		runtime.clearCompactionInFlight(fermentId)
		appendHandoffEntry(result)
		scheduleContinuationBestEffort()
	}

	function handleCompactionFailure(error: unknown): void {
		runtime.clearCompactionInFlight(fermentId)
		// Silently skip expected non-errors: session too small, already
		// compacted, cancelled. These are routine when steps are short.
		if (error instanceof Error && !isExpectedCompactionError(error)) {
			ctx.ui?.notify?.(`Stage compaction failed: ${error.message}`, "warning")
		}
		// Always append the handoff entry even when compaction fails/is skipped.
		// Do not schedule a continuation without a saved compaction summary; the
		// normal reactive/stop nudges can recover without adding duplicate stale turns.
		appendHandoffEntry(undefined, error instanceof Error ? error.message : String(error))
	}

	if (typeof ctx.inlineCompact === "function") {
		// Minimum-size gate: a stage-boundary compaction on a small context costs
		// a multi-minute summarization call and saves almost nothing. Skip it —
		// the pending entry is already drained, the handoff below still delivers
		// plan context to the next stage, and the next stage boundary re-checks
		// once the context has grown.
		const contextTokens = estimateSessionContextTokens(ctx)
		if (contextTokens < options.minContextTokens) {
			runtime.clearCompactionInFlight(fermentId)
			const skipReason = `context ~${contextTokens.toLocaleString()} tokens is below the ${options.minContextTokens.toLocaleString()}-token stage-compaction minimum`
			appendHandoffEntry(undefined, skipReason)
			tryPiAction(() => {
				pi.appendEntry("ferment_breadcrumb", { text: `Stage compaction skipped: ${skipReason}` })
			})
			return true
		}

		// Append the handoff BEFORE compacting. At a stage boundary the session
		// tail is assistant → toolResult, and upstream cannot place a compaction
		// cut point after a toolResult — without a trailing custom_message entry,
		// a forced compaction prepares zero summarizable messages and no-ops
		// (the exact failure observed across whole benchmark runs). The handoff
		// is a valid cut point, so the cut lands here and the next stage keeps
		// exactly what it needs: compaction summary + plan handoff.
		appendHandoffEntry(undefined, undefined, true)
		const { result, error } = await invokeInlineCompaction(pi, ctx, customInstructions, options)
		runtime.clearCompactionInFlight(fermentId)
		if (result) {
			tryPiAction(() => {
				pi.appendEntry("ferment_breadcrumb", {
					text: `Stage compaction complete: ${(result.tokensBefore ?? 0).toLocaleString()} tokens before compaction`,
				})
			})
			scheduleContinuationBestEffort()
		} else {
			const message = error instanceof Error ? error.message : String(error)
			// The handoff entry is already appended; persist the skip reason
			// separately so headless runs (where ui.notify is a no-op) remain
			// diagnosable from session files alone.
			tryPiAction(() => {
				pi.appendEntry("ferment_breadcrumb", {
					text: `Stage compaction skipped: ${message}`,
				})
			})
			if (error instanceof Error && !isExpectedCompactionError(error)) {
				ctx.ui?.notify?.(`Stage compaction failed: ${error.message}`, "warning")
			}
			// Do not schedule a continuation without a saved compaction summary; the
			// normal reactive/stop nudges can recover without adding duplicate stale turns.
		}
		return true
	}

	try {
		ctx.compact({
			customInstructions,
			onComplete: finishCompaction,
			onError: (error: Error) => {
				try {
					handleCompactionFailure(error)
				} catch {
					// Best-effort: never let onError propagate and crash the extension.
				}
			},
		})
	} catch (error) {
		handleCompactionFailure(error)
	}
	return true
}

/**
 * Trigger mid-turn compaction for an active ferment when the context crosses
 * the upstream auto-compaction threshold. Unlike the post-step path, this
 * path is driven directly by turn_end token usage and must resume the
 * in-progress step after compaction.
 *
 * Uses `ctx.inlineCompact` when available (transparent, no run abort) and falls
 * back to the legacy `ctx.compact` otherwise. One-shot runs never compact
 * mid-turn: an overrun there is a planning-quality signal, so it is recorded as
 * a planning failure instead of papered over.
 *
 * @param totalTokens - Current session token count from the assistant usage event.
 */
export async function maybeTriggerMidTurnFermentCompaction(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: FermentRuntime,
	totalTokens: number,
	options: StageCompactionOptions = DEFAULT_STAGE_COMPACTION_OPTIONS,
): Promise<void> {
	const isOneShot = readFermentOneshotFlag(pi)
	if (isOneShot === undefined) return
	if (isOneShot) {
		const active = runtime.getActive()
		if (active && totalTokens > compactionThreshold(ctx.model?.contextWindow ?? Number.MAX_SAFE_INTEGER)) {
			const warnKey = active.id
			if (!runtime.hasMidTurnOneshotWarning(warnKey)) {
				runtime.markMidTurnOneshotWarning(warnKey)
				tryPiAction(() => {
					pi.appendEntry("ferment_breadcrumb", {
						text: `Mid-turn context overrun in oneshot ferment "${active.name}" — treating as planning failure`,
					})
				})
			}
		}
		return
	}

	// /settings Auto-compact toggle — see maybeTriggerFermentCompaction.
	if (!getCompactionEnabled(readProjectTrust(ctx))) return

	const model = ctx.model
	if (!model) return
	if (totalTokens <= compactionThreshold(model.contextWindow)) return

	const activeFerment = runtime.getActive()
	if (!activeFerment) return
	if (activeFerment.status !== "running") return

	const { phase: activePhase, step: activeStep } = findActivePhaseAndStep(activeFerment)
	if (!activePhase || !activeStep) return

	const fermentId = activeFerment.id
	if (runtime.isCompactionInFlight(fermentId)) return

	// Root-cause guard: a mid-turn compaction fires on token overrun, which can
	// land exactly when an assistant toolCall is awaiting its toolResult.
	// Compacting then would summarise away the toolCall and orphan the
	// toolResult appended after compaction. Defer — the context may be large,
	// but emitting an orphan is worse; phase 1 still catches any that slip past.
	if (isToolCallInFlightInSession(ctx)) return

	runtime.markCompactionInFlight(fermentId)

	const customInstructions = buildMidTurnCustomInstructions(activeFerment, activePhase, activeStep)

	/** Resume the in-progress step after a successful compaction: the LLM's
	 *  next-action reasoning was discarded with the old history, so steer it
	 *  back into the exact step that was running when the context filled. */
	function resumeInProgressStep(result: CompactionResult): void {
		const freshFerment = runtime.getStorage().get(fermentId)
		if (!freshFerment) return

		const { phase, step } = findActivePhaseAndStep(freshFerment)
		tryPiAction(() => {
			pi.appendEntry("ferment_breadcrumb", {
				text: `Mid-turn compaction resume: ferment "${freshFerment.name}" · phase ${phase?.index ?? "?"}/${freshFerment.phases.length} "${phase?.name ?? "unknown"}" · step ${step?.index ?? "?"}/${phase?.steps.length ?? 0} · ${(result.tokensBefore ?? 0).toLocaleString()} tokens before compaction`,
			})
		})

		if (freshFerment.status === "running") {
			runtime.setActive(freshFerment)
			scheduleNextFermentAction(pi, freshFerment, runtime, {
				tag: "Auto-compaction continuation",
				deliverAs: "steer",
			})
		}
	}

	function handleCompactionFailure(error: unknown): void {
		runtime.clearCompactionInFlight(fermentId)
		if (error instanceof Error && !isExpectedCompactionError(error)) {
			ctx.ui?.notify?.(`Mid-turn compaction failed: ${error.message}`, "warning")
			// ui.notify is a no-op in headless runs — persist the failure so
			// archives show why the context kept growing past the threshold.
			tryPiAction(() => {
				pi.appendEntry("ferment_breadcrumb", {
					text: `Mid-turn compaction failed: ${error.message}`,
				})
			})
		}
	}

	// Preferred path: transparent inline compaction (no run abort). Mirrors the
	// stage-boundary path's invocation via the shared helper so the two cannot
	// drift; the only differences are the mid-turn instructions and the
	// step-resume continuation below.
	if (typeof ctx.inlineCompact === "function") {
		const { result, error } = await invokeInlineCompaction(pi, ctx, customInstructions, options)
		if (result) {
			runtime.clearCompactionInFlight(fermentId)
			resumeInProgressStep(result)
		} else {
			handleCompactionFailure(error)
		}
		return
	}

	// Legacy fallback: ctx.compact aborts the current run, so the step resumes on
	// the next user turn rather than transparently.
	try {
		ctx.compact({
			customInstructions,
			onComplete: (result: CompactionResult) => {
				runtime.clearCompactionInFlight(fermentId)
				resumeInProgressStep(result)
			},
			onError: handleCompactionFailure,
		})
	} catch (error) {
		// ctx.compact should never throw, but if it does before invoking callbacks
		// the in-flight flag must be cleared so future compactions are not blocked.
		handleCompactionFailure(error)
	}
}
