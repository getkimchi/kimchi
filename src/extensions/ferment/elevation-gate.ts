import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getPermissionMode } from "../permissions/mode-controller.js"
import { hasOrgPolicyRestrictions, highestAllowedHighMode, isFermentRunnable } from "../permissions/policy.js"
import { choiceMatchesLabel } from "../permissions/select-utils.js"
import { clearFermentDegraded, markFermentDegraded } from "./continuation.js"
import type { FermentRuntime } from "./runtime.js"

/**
 * The ferment elevation gate: before a ferment activates into execution, ask
 * the user for permission elevation per the org policy.
 *
 * Ladder (mode-state based, evaluated at each gate run):
 * - current `yolo` → no gate, proceed.
 * - current `auto` → ask only when `yolo` is allowed; declining continues in
 *   auto with no degraded penalty.
 * - current `default`/`plan` → ask for the highest allowed high mode (yolo
 *   preferred over auto); declining takes the degraded path (the caller forces
 *   manual continuation and warns).
 * - no high mode allowed → no ask (nothing to elevate to); degraded — unless
 *   the policy leaves ferment unrunnable (`{plan}`-only) → blocked.
 *
 * The recorded decision is read by the permissions extension's ferment
 * elevation listener (permissions/index.ts) when the ferment activates, so
 * wake-ups and re-activations honor what the user chose instead of
 * re-elevating. Cancelled/block outcomes are NOT recorded: the caller aborts
 * before activating the ferment.
 */
export type FermentGateOutcome =
	| { kind: "elevated"; mode: "auto" | "yolo" }
	| { kind: "stayed" }
	| { kind: "degraded" }
	| { kind: "cancelled" }
	| { kind: "blocked" }

/** Rejection message shared by every seam that refuses ferment under a plan-only policy. */
export const FERMENT_PLAN_ONLY_MESSAGE = "Your organization's policy only allows plan mode — ferment cannot run."

const decisions = new Map<string, FermentGateOutcome>()

/** Gates currently awaiting user input, keyed by ferment id: a second gate for the same ferment joins the first instead of opening a competing dialog. */
const inFlightGates = new Map<string, Promise<FermentGateOutcome>>()

/** The gate decision recorded for a ferment, if its execution seam already ran the gate. */
export function getFermentGateDecision(fermentId: string | undefined): FermentGateOutcome | undefined {
	if (!fermentId) return undefined
	return decisions.get(fermentId)
}

/** Scoped teardown: drop one ferment's decision and degraded marker — never another ferment's. */
export function clearFermentGateDecision(fermentId: string): void {
	decisions.delete(fermentId)
	clearFermentDegraded(fermentId)
}

function record(fermentId: string, outcome: FermentGateOutcome): FermentGateOutcome {
	// Bounded edge: if the ferment was deactivated while the dialog was open
	// (another ferment claimed the global slot) this re-inserts a decision that
	// teardown just dropped. It is never read (only the ACTIVE ferment's
	// decision is consulted) and is overwritten by the ferment's next gate run.
	decisions.set(fermentId, outcome)
	// A fresh non-degraded gate outcome supersedes a stale degraded marker
	// (e.g. the ferment was re-gated after the user manually changed mode).
	if (outcome.kind !== "degraded") clearFermentDegraded(fermentId)
	return outcome
}

export function gateFermentElevation(
	ctx: ExtensionContext,
	fermentId: string,
	label?: string,
): Promise<FermentGateOutcome> {
	// One dialog per ferment: a double /ferment resume or a scheduler wake
	// racing a user resume must join the in-flight gate, not open a competing
	// selector whose last-write-wins outcome could override the user's choice.
	const inFlight = inFlightGates.get(fermentId)
	if (inFlight) return inFlight
	const gate = runGate(ctx, fermentId, label).finally(() => {
		if (inFlightGates.get(fermentId) === gate) inFlightGates.delete(fermentId)
	})
	inFlightGates.set(fermentId, gate)
	return gate
}

async function runGate(ctx: ExtensionContext, fermentId: string, label?: string): Promise<FermentGateOutcome> {
	// Fail open: without a restricting policy nothing is asked and nothing
	// changes (historical behavior — the elevation listener elevates to yolo).
	if (!hasOrgPolicyRestrictions()) return record(fermentId, { kind: "stayed" })
	if (!isFermentRunnable()) return { kind: "blocked" }
	const current = getPermissionMode(ctx.sessionManager.getSessionId())?.mode ?? "default"
	const target = highestAllowedHighMode()

	// Nothing to elevate to from here: yolo is top; auto only asks for yolo.
	if (current === "yolo" || (current === "auto" && target !== "yolo")) {
		return record(fermentId, { kind: "stayed" })
	}
	// default/plan with no high mode allowed: degraded straight away (default
	// must be allowed — the runnable check above passed for anything else).
	if (!target) return record(fermentId, { kind: "degraded" })
	// No UI (headless resume): no one to ask; proceed in the current clamped mode.
	if (!ctx.hasUI) return record(fermentId, { kind: "stayed" })

	const elevateLabel = current === "auto" ? "Elevate to yolo & run" : `Elevate to ${target} & run`
	const declineLabel = current === "auto" ? "Continue in auto" : "Run in default (degraded)"
	const options = [elevateLabel, declineLabel, "Cancel"]
	const choice = await ctx.ui.select(
		`Ferment "${label ?? fermentId}" — current permission mode: ${current}. Elevate for unattended execution?`,
		options,
	)
	// Selectors may decorate labels (number prefixes, status markers) — match
	// through the shared selector matcher.
	const picked = choice === undefined ? undefined : options.find((label) => choiceMatchesLabel(choice, label))
	if (picked === undefined || picked === "Cancel") return { kind: "cancelled" }
	if (picked === elevateLabel) return record(fermentId, { kind: "elevated", mode: target })
	if (current === "auto") return record(fermentId, { kind: "stayed" })
	return record(fermentId, { kind: "degraded" })
}

/**
 * Declined elevation (shared by every gate seam): keep THIS ferment on manual
 * continuation so approval-requiring stalls surface immediately, and surface a
 * persistent status entry alongside the one-time notice.
 *
 * The manual continuation is tracked per ferment (continuation.ts), not by
 * flipping the process-global continuation policy — that knob is shared by
 * every ferment in the process, and one session's decline must not stop a
 * concurrent ferment's automated wake-ups.
 */
export function applyDegradedFermentStart(ctx: ExtensionContext, fermentId: string): void {
	markFermentDegraded(fermentId)
	ctx.ui.notify(
		"Running ferment in default mode (degraded): background steps cannot answer approval prompts and will stall on actions that need one.",
		"warning",
	)
	ctx.ui.setStatus?.("ferment-degraded", "⚠ Ferment degraded: default mode — steps may stall on approvals")
}

/**
 * Deactivate a gated draft only if it still owns the process-global active slot.
 * While the gate dialog was open, another ferment (e.g. another session's
 * wake-up) may have claimed the slot — tearing it down would pause a live
 * ferment, clear its lockfile, and drop its recorded gate decision.
 */
export function deactivateIfStillActive(runtime: FermentRuntime, fermentId: string): void {
	if (runtime.getActive()?.id === fermentId) runtime.setActive(undefined)
}
