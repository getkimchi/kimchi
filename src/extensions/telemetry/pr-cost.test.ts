import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { collectMetrics, createCumulativeState } from "./accumulator.js"
import { trackPRCostMetric } from "./pr-cost.js"
import type { TelemetryContext } from "./session-context.js"

const fixture = vi.hoisted(() => ({
	enabled: true,
	context: undefined as Pick<TelemetryContext, "config" | "cumulative"> | undefined,
}))
vi.mock("./index.js", () => ({ _getTelemetryCtx: () => fixture.context }))
vi.mock("../../config.js", () => ({ readTelemetryConfig: () => ({ enabled: fixture.enabled }) }))

beforeEach(() => {
	fixture.enabled = true
	fixture.context = {
		config: { enabled: true, metricsEndpoint: "http://localhost/metrics", endpoint: "", headers: {}, apiKey: "" },
		cumulative: createCumulativeState(),
	}
})
afterEach(() => vi.useRealTimers())

it("counts decisions and attempts while replacing queue and price gauges", () => {
	trackPRCostMetric({ kind: "matching", outcome: "explicit" })
	trackPRCostMetric({ kind: "matching", outcome: "explicit" })
	trackPRCostMetric({ kind: "matching", outcome: "unknown" })
	trackPRCostMetric({ kind: "delivery", outcome: "failed" })
	trackPRCostMetric({ kind: "delivery", outcome: "success" })
	trackPRCostMetric({ kind: "unpriced", value: 4 })
	trackPRCostMetric({ kind: "unpriced", value: 1 })
	trackPRCostMetric({ kind: "queueDepth", value: 2 })
	trackPRCostMetric({ kind: "queueDepth", value: 0 })
	expect(fixture.context?.cumulative.prCost).toEqual({
		startTimeUnixNano: expect.any(String),
		matching: { explicit: 2, unknown: 1 },
		delivery: { failed: 1, success: 1 },
		unpriced: 1,
		queueDepth: 0,
	})
	const state = fixture.context?.cumulative
	expect(state).toBeDefined()
	if (!state) throw new Error("Missing test accumulator")
	const metrics = collectMetrics(state)
	expect(metrics).toHaveLength(6)
	expect(metrics.every((metric) => metric.scope === "aggregate")).toBe(true)
	expect(metrics.filter((metric) => metric.type === "Gauge").map((metric) => metric.value)).toEqual([1, 0])
	expect(collectMetrics(state)).toEqual(metrics)
})

it("does not collect while disabled and clears prior values when consent is revoked", () => {
	vi.useFakeTimers()
	vi.setSystemTime(100_000)
	const context = fixture.context
	if (!context) throw new Error("Missing test context")
	trackPRCostMetric({ kind: "matching", outcome: "explicit" })
	const before = collectMetrics(context.cumulative)[0].startTimeUnixNano
	fixture.enabled = false
	trackPRCostMetric({ kind: "delivery", outcome: "failed" })
	expect(fixture.context?.cumulative.prCost).toBeUndefined()
	fixture.enabled = true
	vi.setSystemTime(105_000)
	trackPRCostMetric({ kind: "matching", outcome: "session" })
	expect(fixture.context?.cumulative.prCost?.matching).toEqual({ session: 1 })
	const after = collectMetrics(context.cumulative)[0].startTimeUnixNano
	expect(after).not.toEqual(before)
})

it("measures elapsed time since reconciliation rather than claiming lookup success", () => {
	vi.useFakeTimers()
	vi.setSystemTime(100_000)
	trackPRCostMetric({ kind: "reconciliation" })
	vi.setSystemTime(135_000)
	const state = fixture.context?.cumulative
	if (!state) throw new Error("Missing test accumulator")
	expect(collectMetrics(state)).toContainEqual({
		name: "kimchi.pr_cost.reconciliation.age",
		type: "Gauge",
		value: 35,
		attrs: {},
		scope: "aggregate",
		startTimeUnixNano: "100000000000",
	})
})

it("ignores invalid gauge values and works without a telemetry instance", () => {
	for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) trackPRCostMetric({ kind: "queueDepth", value })
	expect(fixture.context?.cumulative.prCost?.queueDepth).toBeUndefined()
	fixture.context = undefined
	expect(() => trackPRCostMetric({ kind: "matching", outcome: "explicit" })).not.toThrow()
})

it("reports the largest queued snapshot's requests and bytes as client-only gauges", () => {
	trackPRCostMetric({ kind: "snapshotRequests", value: 32_000 })
	trackPRCostMetric({ kind: "snapshotBytes", value: 8 * 1024 * 1024 })
	trackPRCostMetric({ kind: "snapshotRequests", value: 120 })
	for (const value of [-1, 1.5, Number.NaN]) trackPRCostMetric({ kind: "snapshotBytes", value })
	const state = fixture.context?.cumulative
	if (!state) throw new Error("Missing test accumulator")
	const gauges = collectMetrics(state).filter((metric) => metric.name.startsWith("kimchi.pr_cost.snapshot."))
	expect(gauges).toEqual([
		{
			name: "kimchi.pr_cost.snapshot.requests",
			type: "Gauge",
			value: 120,
			attrs: {},
			scope: "aggregate",
			startTimeUnixNano: expect.any(String),
		},
		{
			name: "kimchi.pr_cost.snapshot.bytes",
			type: "Gauge",
			value: 8 * 1024 * 1024,
			attrs: {},
			scope: "aggregate",
			startTimeUnixNano: expect.any(String),
		},
	])
})
