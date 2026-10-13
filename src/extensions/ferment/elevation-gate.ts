import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getPermissionMode } from "../permissions/mode-controller.js"
import { hasOrgPolicyRestrictions, highestAllowedHighMode, isFermentRunnable } from "../permissions/policy.js"
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

const decisions = new Map<string, FermentGateOutcome>()

/** The gate decision recorded for a ferment, if its execution seam already ran the gate. */
export function getFermentGateDecision(fermentId: string): FermentGateOutcome | undefined {
	return decisions.get(fermentId)
}

/** Scoped teardown: drop one ferment's decision — never another ferment's. */
export function clearFermentGateDecision(fermentId: string): void {
	decisions.delete(fermentId)
}

function record(fermentId: string, outcome: FermentGateOutcome): FermentGateOutcome {
	decisions.set(fermentId, outcome)
	return outcome
}

export async function gateFermentElevation(
	ctx: ExtensionContext,
	fermentId: string,
	label?: string,
): Promise<FermentGateOutcome> {
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
	// Selectors may decorate labels (e.g. number prefixes) — match by suffix.
	const picked = choice === undefined ? undefined : options.find((label) => choice.endsWith(label))
	if (picked === undefined || picked === "Cancel") return { kind: "cancelled" }
	if (picked === elevateLabel) return record(fermentId, { kind: "elevated", mode: target })
	if (current === "auto") return record(fermentId, { kind: "stayed" })
	return record(fermentId, { kind: "degraded" })
}

/**
 * Declined elevation (shared by every gate seam): force manual continuation so
 * approval-requiring stalls surface immediately, and surface a persistent
 * status entry alongside the one-time notice.
 */
export function applyDegradedFermentStart(ctx: ExtensionContext, runtime: FermentRuntime): void {
	runtime.setContinuationPolicy("manual")
	ctx.ui?.notify?.(
		"Running ferment in default mode (degraded): background steps cannot answer approval prompts and will stall on actions that need one.",
		"warning",
	)
	ctx.ui.setStatus?.("ferment-degraded", "⚠ Ferment degraded: default mode — steps may stall on approvals")
}
