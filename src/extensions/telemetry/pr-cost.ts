import { readTelemetryConfig } from "../../config.js"
import type { WorkSegment } from "../work-attribution.js"
import { nowNano } from "./helpers.js"
import { _getTelemetryCtx } from "./index.js"

type PRCostMetric =
	| { kind: "matching"; outcome: WorkSegment["attribution"] | "failed" }
	| { kind: "delivery"; outcome: "success" | "failed" | "canceled" }
	| { kind: "unpriced" | "queueDepth"; value: number }
	| { kind: "reconciliation" }

/** Accept counts and fixed outcomes only; identifiers and error text never enter metric labels. */
export function trackPRCostMetric(metric: PRCostMetric): void {
	const ctx = _getTelemetryCtx()
	if (!ctx) return
	if (!ctx.config.enabled || !ctx.config.metricsEndpoint || !readTelemetryConfig().enabled) {
		ctx.cumulative.prCost = undefined
		return
	}
	ctx.cumulative.prCost ??= { matching: {}, delivery: {}, startTimeUnixNano: nowNano() }
	const state = ctx.cumulative.prCost
	if (metric.kind === "matching" || metric.kind === "delivery") {
		const counts: Partial<Record<string, number>> = state[metric.kind]
		counts[metric.outcome] = (counts[metric.outcome] ?? 0) + 1
	} else if (metric.kind === "reconciliation") state.reconciliationStartedAt = Date.now()
	else if (Number.isSafeInteger(metric.value) && metric.value >= 0) state[metric.kind] = metric.value
}
