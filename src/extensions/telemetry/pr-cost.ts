import { readTelemetryConfig } from "../../config.js"
import type { WorkSegment } from "../work-attribution.js"
import { nowNano } from "./helpers.js"
import { _getTelemetryCtx } from "./index.js"

export type PRCostMetric =
	| { kind: "matching"; outcome: WorkSegment["attribution"] | "failed" | "limited" }
	| { kind: "delivery"; outcome: "success" | "failed" | "canceled" }
	/** A repository identity lookup: `denied` is the provider's 401, 403 or 404, `failed` anything else that went wrong. */
	| { kind: "lookup"; outcome: "success" | "unsupported" | "denied" | "failed" }
	/**
	 * pricingPending counts unpriced requests whose billing lookup can still price them. snapshotRequests and
	 * snapshotBytes describe the largest snapshot queued in a reporting pass. reportingEnabled is 1 or 0.
	 */
	| {
			kind: "pricingPending" | "queueDepth" | "snapshotRequests" | "snapshotBytes" | "reportingEnabled"
			value: number
	  }
	| { kind: "reconciliation" }

/** Accept counts and fixed outcomes only; identifiers and error text never enter metric labels. */
export function trackPRCostMetric(metric: PRCostMetric): void {
	const ctx = _getTelemetryCtx()
	if (!ctx) return
	const consent = readTelemetryConfig()
	if (!ctx.config.enabled || !ctx.config.metricsEndpoint || !consent.enabled) {
		ctx.cumulative.prCost = undefined
		return
	}
	if (ctx.cumulative.prCost?.consentVersion !== consent.consentVersion) ctx.cumulative.prCost = undefined
	ctx.cumulative.prCost ??= {
		matching: {},
		delivery: {},
		lookup: {},
		startTimeUnixNano: nowNano(),
		consentVersion: consent.consentVersion,
	}
	const state = ctx.cumulative.prCost
	if (metric.kind === "matching" || metric.kind === "delivery" || metric.kind === "lookup") {
		const counts: Partial<Record<typeof metric.outcome, number>> = state[metric.kind]
		counts[metric.outcome] = (counts[metric.outcome] ?? 0) + 1
	} else if (metric.kind === "reconciliation") state.reconciliationStartedAt = Date.now()
	else if (Number.isSafeInteger(metric.value) && metric.value >= 0) state[metric.kind] = metric.value
}
