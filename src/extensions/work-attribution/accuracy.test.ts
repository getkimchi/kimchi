import { describe, expect, it } from "vitest"
import type { AttributionLabel } from "./accuracy.js"
import { compareAttributionAccuracy } from "./accuracy.js"
import { decimalNanos, type RequestCostAllocation } from "./costs.js"

const NANOS_PER_USD = 1_000_000_000n
const PR1 = "github:acme/api#1"
const PR2 = "github:acme/api#2"
const PR7 = "github:acme/api#7"
const PR8 = "github:acme/api#8"
const PR9 = "github:acme/api#9"

/** Full RequestCostAllocation fixture with realistic defaults; only the priced fields matter to the function. */
function row(requestId: string, overrides: Partial<RequestCostAllocation> = {}): RequestCostAllocation {
	return {
		requestId,
		account: {
			apiUrl: "https://api.example.test",
			organizationId: "11111111-1111-4111-8111-111111111111",
			userId: "22222222-2222-4222-8222-222222222222",
		},
		workIds: [`work-${requestId}`],
		sessionIds: [`session-${requestId}`],
		startedAt: "2026-01-15T10:00:00.000Z",
		pullRequestIds: [],
		allocation: "unlinked",
		billingRecordIds: [`billing-${requestId}`],
		priceStatus: "priced",
		knownCostUsd: "0.000000000",
		totalCostUsd: overrides.knownCostUsd ?? "0.000000000",
		...overrides,
	}
}

function label(requestId: string, expectedPullRequestId: string | null): AttributionLabel {
	return { requestId, expectedPullRequestId }
}

/** Exact bucket shape, with the USD string derived by the pinned integer formula (verified against node bigint math). */
function bucket(requestIds: string[], nanos: bigint) {
	return {
		requestIds,
		knownCostUsd: `${nanos / NANOS_PER_USD}.${(nanos % NANOS_PER_USD).toString().padStart(9, "0")}`,
		knownCostNanos: nanos,
	}
}

function percentages(referenceNanos: bigint, correctNanos: bigint, wrongNanos: bigint) {
	const render = (numerator: bigint, denominator: bigint) => {
		if (denominator === 0n) return null
		const quotient = (numerator * 100_000_000_000n) / denominator
		return `${quotient / NANOS_PER_USD}.${(quotient % NANOS_PER_USD).toString().padStart(9, "0")}`
	}
	return {
		correctCoveragePercent: render(correctNanos, referenceNanos),
		wrongAssignmentPercent: render(wrongNanos, correctNanos + wrongNanos),
	}
}

const noPercentages = { correctCoveragePercent: null, wrongAssignmentPercent: null }

describe("accuracy readiness regressions", () => {
	it.each([
		"9.000000000",
		"0.000000000",
	])("does not call a report complete when an unlabelled request costs %s USD", (knownCostUsd) => {
		const result = compareAttributionAccuracy(
			[
				row("labelled", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" }),
				row("unlabelled", { allocation: "pull-request", pullRequestIds: [PR2], knownCostUsd }),
			],
			[label("labelled", PR1)],
		)

		expect(result.complete).toBe(false)
	})

	it("requires labels when the report contains requests", () => {
		const result = compareAttributionAccuracy([row("unlabelled", { knownCostUsd: "1.000000000" })], [])

		expect(result.complete).toBe(false)
	})

	it("reports the USD 9 excluded from a perfect USD 1 labelled subset", () => {
		const result = compareAttributionAccuracy(
			[
				row("labelled", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" }),
				row("unlabelled", { allocation: "pull-request", pullRequestIds: [PR2], knownCostUsd: "9.000000000" }),
			],
			[label("labelled", PR1)],
		)

		expect(result).toMatchObject({
			coverage: {
				reportRequests: 2,
				labelledRequests: 1,
				pricedRequests: 2,
				scoredRequests: 1,
				reportKnownCostUsd: "10.000000000",
				scoredKnownCostUsd: "1.000000000",
				unlabelledRequestIds: ["unlabelled"],
				unpricedRequestIds: [],
			},
		})
	})

	it("shows an unpriced request even when nobody labelled it", () => {
		const result = compareAttributionAccuracy(
			[
				row("labelled", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" }),
				row("pending", { priceStatus: "missing", totalCostUsd: null }),
			],
			[label("labelled", PR1)],
		)

		expect(result).toMatchObject({
			complete: false,
			coverage: {
				reportRequests: 2,
				pricedRequests: 1,
				reportKnownCostUsd: "1.000000000",
				unlabelledRequestIds: ["pending"],
				unpricedRequestIds: ["pending"],
			},
		})
	})

	it("measures wrong assignments against assigned dollars, including unrelated chat", () => {
		const result = compareAttributionAccuracy(
			[
				row("correct", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" }),
				row("unrelated", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "3.000000000" }),
			],
			[label("correct", PR1), label("unrelated", null)],
		)

		expect(result).toMatchObject({
			metrics: { wrongAssignmentPercent: "75.000000000", correctCoveragePercent: "100.000000000" },
		})
	})

	it("reports all assignments wrong even when no spending should belong to a PR", () => {
		const result = compareAttributionAccuracy(
			[row("unrelated", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "3.000000000" })],
			[label("unrelated", null)],
		)

		expect(result).toMatchObject({
			metrics: { wrongAssignmentPercent: "100.000000000", correctCoveragePercent: null },
		})
	})
})

/**
 * Mixed fixture exercising every bucket and problem stage at once.
 * Row order (0-based): 0 correct, 1 wrong, 2 shared, 3 unmerged, 4 null-labeled confident, 5 unlabeled,
 * 6 unpriced, 7 duprow original, 8 duprow duplicate, 9 unusable non-object row.
 */
function mixedFixture(): { requests: unknown[]; labels: AttributionLabel[] } {
	const requests: unknown[] = [
		row("req-correct", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" }),
		row("req-wrong", { allocation: "pull-request", pullRequestIds: [PR9], knownCostUsd: "2.000000000" }),
		row("req-shared", { allocation: "shared", pullRequestIds: [PR1], knownCostUsd: "0.500000000" }),
		row("req-unmerged", { allocation: "unmerged", pullRequestIds: [PR1], knownCostUsd: "0.250000000" }),
		row("req-nullconf", { allocation: "pull-request", pullRequestIds: [PR7], knownCostUsd: "3.000000000" }),
		row("req-nolabel", { allocation: "pull-request", pullRequestIds: [PR8], knownCostUsd: "9.000000000" }),
		row("req-unpriced", {
			allocation: "pull-request",
			pullRequestIds: [PR2],
			priceStatus: "missing",
			knownCostUsd: "0.000000000",
			totalCostUsd: null,
		}),
		row("req-duprow", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" }),
		row("req-duprow", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "5.000000000" }),
		// Deliberately unusable runtime row; the function must flag it, never crash.
		"garbage-row",
	]
	const labels: AttributionLabel[] = [
		label("req-dup", null),
		label("req-dup", null),
		label("req-correct", PR1),
		label("req-wrong", PR1),
		label("req-shared", PR1),
		label("req-unmerged", PR1),
		label("req-nullconf", null),
		label("req-unpriced", PR2),
		label("req-duprow", PR1),
		label("req-ghost", PR1),
	]
	return { requests, labels }
}

describe("compareAttributionAccuracy", () => {
	it("excludes a priced row with no final decimal amount from scoring", () => {
		const result = compareAttributionAccuracy(
			[
				row("malformed", {
					allocation: "pull-request",
					pullRequestIds: [PR1],
					knownCostUsd: "1.000000001",
					totalCostUsd: null,
				}),
			],
			[label("malformed", PR1)],
		)
		expect(result.complete).toBe(false)
		expect(result.correct.requestIds).toEqual([])
		expect(result.coverage.scoredRequests).toBe(0)
		expect(result.problems).toContainEqual(
			expect.objectContaining({ kind: "invalid-report-row", requestId: "malformed" }),
		)
		expect(result.metrics).toEqual({ correctCoveragePercent: null, wrongAssignmentPercent: null })
	})

	it("accepts inferred rows without counting their candidate as a confirmed assignment", () => {
		const result = compareAttributionAccuracy(
			[row("inferred", { allocation: "inferred", pullRequestIds: [PR1], knownCostUsd: "1.000000001" })],
			[label("inferred", PR1)],
		)
		expect(result.complete).toBe(true)
		expect(result.problems).toEqual([])
		expect(result.correct.requestIds).toEqual([])
		expect(result.assigned.requestIds).toEqual([])
		expect(result.missed.requestIds).toEqual(["inferred"])
	})

	it("scores confident correct assignments and lands the null-labeled unlinked row in no bucket (all-correct)", () => {
		const requests = [
			row("req-a", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" }),
			row("req-b", { allocation: "pull-request", pullRequestIds: [PR2], knownCostUsd: "0.250000000" }),
			row("req-null-unlinked", { allocation: "unlinked", knownCostUsd: "0.500000000" }),
		]
		const labels = [label("req-a", PR1), label("req-b", PR2), label("req-null-unlinked", null)]
		const result = compareAttributionAccuracy(requests, labels)
		expect(result.complete).toBe(true)
		expect(result.problems).toEqual([])
		// The 0.500000000 null-labeled unlinked request contributes to no bucket at all.
		expect(result.reference).toEqual(bucket(["req-a", "req-b"], 1_250_000_000n))
		expect(result.correct).toEqual(bucket(["req-a", "req-b"], 1_250_000_000n))
		expect(result.wrong).toEqual(bucket([], 0n))
		expect(result.missed).toEqual(bucket([], 0n))
		expect(result.metrics).toEqual(percentages(1_250_000_000n, 1_250_000_000n, 0n))
	})

	it("counts a confidently wrong PR as both wrong and missed for the same request", () => {
		const requests = [
			row("req-ok", { allocation: "pull-request", pullRequestIds: [PR2], knownCostUsd: "0.300000000" }),
			row("req-wrong", { allocation: "pull-request", pullRequestIds: [PR9], knownCostUsd: "2.000000000" }),
		]
		const labels = [label("req-ok", PR2), label("req-wrong", PR1)]
		const result = compareAttributionAccuracy(requests, labels)
		expect(result.complete).toBe(true)
		expect(result.problems).toEqual([])
		expect(result.reference).toEqual(bucket(["req-ok", "req-wrong"], 2_300_000_000n))
		expect(result.correct).toEqual(bucket(["req-ok"], 300_000_000n))
		expect(result.wrong).toEqual(bucket(["req-wrong"], 2_000_000_000n))
		expect(result.missed).toEqual(bucket(["req-wrong"], 2_000_000_000n))
		// The same request id is confidently assigned yet missed its expectation.
		expect(result.wrong.requestIds).toContain("req-wrong")
		expect(result.missed.requestIds).toContain("req-wrong")
		// Truncated integer math: 0.30/2.30 is 13.043478260…%, never rounded up to …261.
		expect(result.metrics).toEqual(percentages(2_300_000_000n, 300_000_000n, 2_000_000_000n))
		expect(result.correct.knownCostNanos + result.missed.knownCostNanos).toBe(result.reference.knownCostNanos)
	})

	it("counts an unmerged non-confident assignment as missed only, never wrong", () => {
		const requests = [
			row("req-unmerged", { allocation: "unmerged", pullRequestIds: [PR1], knownCostUsd: "1.500000000" }),
		]
		const labels = [label("req-unmerged", PR1)]
		const result = compareAttributionAccuracy(requests, labels)
		expect(result.complete).toBe(true)
		expect(result.problems).toEqual([])
		expect(result.reference).toEqual(bucket(["req-unmerged"], 1_500_000_000n))
		expect(result.correct).toEqual(bucket([], 0n))
		expect(result.wrong).toEqual(bucket([], 0n))
		expect(result.missed).toEqual(bucket(["req-unmerged"], 1_500_000_000n))
		expect(result.metrics).toEqual(percentages(1_500_000_000n, 0n, 0n))
	})

	it("counts shared work as missed only, never wrong, even when the expected PR is linked", () => {
		const requests = [row("req-shared", { allocation: "shared", pullRequestIds: [PR1], knownCostUsd: "0.750000000" })]
		const labels = [label("req-shared", PR1)]
		const result = compareAttributionAccuracy(requests, labels)
		expect(result.complete).toBe(true)
		expect(result.problems).toEqual([])
		expect(result.reference).toEqual(bucket(["req-shared"], 750_000_000n))
		expect(result.correct).toEqual(bucket([], 0n))
		expect(result.wrong).toEqual(bucket([], 0n))
		expect(result.missed).toEqual(bucket(["req-shared"], 750_000_000n))
		expect(result.metrics).toEqual(percentages(750_000_000n, 0n, 0n))
	})

	it("excludes unpriced requests with explicit problems and null metrics", () => {
		// Guard the fixture itself: the production parser must reject this amount.
		expect(decimalNanos("1.2345678901")).toBeUndefined()
		const requests = [
			row("req-p1", { allocation: "pull-request", pullRequestIds: [PR1], priceStatus: "missing", totalCostUsd: null }),
			row("req-p2", { allocation: "pull-request", pullRequestIds: [PR2], priceStatus: "invalid", totalCostUsd: null }),
			row("req-p3", { allocation: "pull-request", pullRequestIds: [PR1], priceStatus: "conflict", totalCostUsd: null }),
			row("req-p4", {
				allocation: "pull-request",
				pullRequestIds: [PR1],
				knownCostUsd: "1.2345678901",
				totalCostUsd: null,
			}),
			row("req-good", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" }),
		]
		const labels = [
			label("req-p1", PR1),
			label("req-p2", PR2),
			label("req-p3", null),
			label("req-p4", PR1),
			label("req-good", PR1),
		]
		const result = compareAttributionAccuracy(requests, labels)
		expect(result.complete).toBe(false)
		// Incomplete results never claim a rate, even though reference spending is positive.
		expect(result.metrics).toEqual(noPercentages)
		expect(result.problems).toEqual([
			{ kind: "unpriced-request", requestId: "req-p1", detail: expect.stringContaining("missing") },
			{ kind: "unpriced-request", requestId: "req-p2", detail: expect.stringContaining("invalid") },
			{ kind: "unpriced-request", requestId: "req-p3", detail: expect.stringContaining("conflict") },
			{ kind: "unpriced-request", requestId: "req-p4", detail: expect.stringContaining("1.2345678901") },
		])
		// Excluded requests are never counted, not even as zero — including the null-labeled req-p3.
		expect(result.reference).toEqual(bucket(["req-good"], 1_000_000_000n))
		expect(result.correct).toEqual(bucket(["req-good"], 1_000_000_000n))
		expect(result.wrong).toEqual(bucket([], 0n))
		expect(result.missed).toEqual(bucket([], 0n))
	})

	it("rejects identical duplicate labels without deduplicating them into one count", () => {
		const requests = [row("req-d", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" })]
		const labels = [label("req-d", PR1), label("req-d", PR1)]
		const result = compareAttributionAccuracy(requests, labels)
		expect(result.complete).toBe(false)
		expect(result.metrics).toEqual(noPercentages)
		expect(result.problems).toEqual([
			{ kind: "duplicate-label", requestId: "req-d", detail: expect.stringMatching(/\S/) },
		])
		// Duplicates are defects: the request is counted zero times, not once.
		expect(result.reference).toEqual(bucket([], 0n))
		expect(result.correct).toEqual(bucket([], 0n))
		expect(result.wrong).toEqual(bucket([], 0n))
		expect(result.missed).toEqual(bucket([], 0n))
	})

	it("returns null percentages for a complete zero-reference result without NaN amounts", () => {
		const requests = [
			row("req-u1", { allocation: "unlinked", knownCostUsd: "1.000000000" }),
			row("req-u2", { allocation: "shared", pullRequestIds: [PR1], knownCostUsd: "2.000000000" }),
		]
		const labels = [label("req-u1", null), label("req-u2", null)]
		const result = compareAttributionAccuracy(requests, labels)
		expect(result.complete).toBe(true)
		expect(result.problems).toEqual([])
		// Null-labeled non-confident rows land in no bucket, so the reference is exactly zero.
		expect(result.reference).toEqual(bucket([], 0n))
		expect(result.correct).toEqual(bucket([], 0n))
		expect(result.wrong).toEqual(bucket([], 0n))
		expect(result.missed).toEqual(bucket([], 0n))
		expect(result.metrics).toEqual(noPercentages)
	})

	it("rejects conflicting labels for the same request", () => {
		const requests = [row("req-cf", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" })]
		const labels = [label("req-cf", PR1), label("req-cf", PR2)]
		const result = compareAttributionAccuracy(requests, labels)
		expect(result.complete).toBe(false)
		expect(result.metrics).toEqual(noPercentages)
		expect(result.problems).toEqual([
			{ kind: "conflicting-labels", requestId: "req-cf", detail: expect.stringMatching(/\S/) },
		])
		expect(result.reference).toEqual(bucket([], 0n))
		expect(result.correct).toEqual(bucket([], 0n))
		expect(result.wrong).toEqual(bucket([], 0n))
		expect(result.missed).toEqual(bucket([], 0n))
	})

	it("flags malformed label entries as invalid-label without crashing", () => {
		const requests = [row("req-ok", { knownCostUsd: "1.000000000" })]
		// Deliberately malformed runtime input; each entry must be flagged, not crash the run.
		const labels = [
			null,
			42,
			["req-array", null],
			{ expectedPullRequestId: null },
			{ requestId: 7, expectedPullRequestId: null },
			{ requestId: "req-x", expectedPullRequestId: 7 },
			// Extra properties are tolerated: this entry is shape-valid and must not be flagged.
			{ requestId: "req-ok", expectedPullRequestId: null, source: "manual" },
		]
		const result = compareAttributionAccuracy(requests, labels)
		expect(result.complete).toBe(false)
		expect(result.metrics).toEqual(noPercentages)
		expect(result.problems).toEqual([
			{ kind: "invalid-label", requestId: null, detail: expect.stringMatching(/\S/) },
			{ kind: "invalid-label", requestId: null, detail: expect.stringMatching(/\S/) },
			{ kind: "invalid-label", requestId: null, detail: expect.stringMatching(/\S/) },
			{ kind: "invalid-label", requestId: null, detail: expect.stringMatching(/\S/) },
			{ kind: "invalid-label", requestId: null, detail: expect.stringMatching(/\S/) },
			{ kind: "invalid-label", requestId: "req-x", detail: expect.stringMatching(/\S/) },
		])
		expect(result.reference).toEqual(bucket([], 0n))
		expect(result.correct).toEqual(bucket([], 0n))
		expect(result.wrong).toEqual(bucket([], 0n))
		expect(result.missed).toEqual(bucket([], 0n))
	})

	it("flags malformed expected PR keys as invalid-expected-pull-request-id", () => {
		const requests = [
			row("req-i1", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" }),
			row("req-i2", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" }),
			row("req-i3", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" }),
			row("req-i4", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" }),
			row("req-valid", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "0.100000000" }),
		]
		const labels = [
			label("req-i1", "github:owner/repo#0"),
			label("req-i2", "GitHub:owner/repo#1"),
			label("req-i3", "nocolon"),
			label("req-i4", "github:owner#1"),
			label("req-valid", PR1),
		]
		const result = compareAttributionAccuracy(requests, labels)
		expect(result.complete).toBe(false)
		expect(result.metrics).toEqual(noPercentages)
		expect(result.problems).toEqual([
			{ kind: "invalid-expected-pull-request-id", requestId: "req-i1", detail: expect.stringMatching(/\S/) },
			{ kind: "invalid-expected-pull-request-id", requestId: "req-i2", detail: expect.stringMatching(/\S/) },
			{ kind: "invalid-expected-pull-request-id", requestId: "req-i3", detail: expect.stringMatching(/\S/) },
			{ kind: "invalid-expected-pull-request-id", requestId: "req-i4", detail: expect.stringMatching(/\S/) },
		])
		// Only the well-formed key survives validation.
		expect(result.reference).toEqual(bucket(["req-valid"], 100_000_000n))
		expect(result.correct).toEqual(bucket(["req-valid"], 100_000_000n))
		expect(result.wrong).toEqual(bucket([], 0n))
		expect(result.missed).toEqual(bucket([], 0n))
	})

	it("flags labels without a report row as missing-report-row", () => {
		const requests = [
			row("req-real", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" }),
		]
		const labels = [label("req-ghost", PR1), label("req-real", PR1)]
		const result = compareAttributionAccuracy(requests, labels)
		expect(result.complete).toBe(false)
		expect(result.metrics).toEqual(noPercentages)
		expect(result.problems).toEqual([
			{ kind: "missing-report-row", requestId: "req-ghost", detail: expect.stringMatching(/\S/) },
		])
		expect(result.reference).toEqual(bucket(["req-real"], 1_000_000_000n))
		expect(result.correct).toEqual(bucket(["req-real"], 1_000_000_000n))
		expect(result.wrong).toEqual(bucket([], 0n))
		expect(result.missed).toEqual(bucket([], 0n))
	})

	it("flags duplicate report rows and excludes labels referencing the duplicated request", () => {
		const requests = [
			row("req-good", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" }),
			row("req-dup", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" }),
			row("req-dup", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "5.000000000" }),
		]
		const labels = [label("req-dup", PR1), label("req-good", PR1)]
		const result = compareAttributionAccuracy(requests, labels)
		expect(result.complete).toBe(false)
		expect(result.metrics).toEqual(noPercentages)
		// The duplicated row sits at 0-based index 2; the invalid-report-row problem is the only
		// record of the exclusion — no extra missing-report-row problem is added for the label.
		expect(result.problems).toEqual([
			{ kind: "invalid-report-row", requestId: null, detail: expect.stringContaining("2") },
		])
		expect(result.reference).toEqual(bucket(["req-good"], 1_000_000_000n))
		expect(result.correct).toEqual(bucket(["req-good"], 1_000_000_000n))
		expect(result.wrong).toEqual(bucket([], 0n))
		expect(result.missed).toEqual(bucket([], 0n))
	})

	it("flags every further duplicate report row, not just the second", () => {
		const requests = [
			row("req-good", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" }),
			row("req-dup", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" }),
			row("req-dup", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" }),
			row("req-dup", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" }),
		]
		const labels = [label("req-dup", PR1), label("req-good", PR1)]
		const result = compareAttributionAccuracy(requests, labels)
		expect(result.complete).toBe(false)
		expect(result.metrics).toEqual(noPercentages)
		// Each further usable row repeating an already-duplicated id gets its own problem (0-based
		// indices 2 and 3); the stage-4 problems are the only record — no missing-report-row is
		// added for the label sitting on the duplicated id.
		expect(result.problems).toEqual([
			{ kind: "invalid-report-row", requestId: null, detail: expect.stringContaining("2") },
			{ kind: "invalid-report-row", requestId: null, detail: expect.stringContaining("3") },
		])
		expect(result.reference).toEqual(bucket(["req-good"], 1_000_000_000n))
		expect(result.correct).toEqual(bucket(["req-good"], 1_000_000_000n))
		expect(result.wrong).toEqual(bucket([], 0n))
		expect(result.missed).toEqual(bucket([], 0n))
	})

	it("counts null-labeled confident assignments in the assigned-spending denominator", () => {
		const requests = [
			row("req-ok", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" }),
			row("req-null", { allocation: "pull-request", pullRequestIds: [PR9], knownCostUsd: "2.500000000" }),
		]
		const labels = [label("req-ok", PR1), label("req-null", null)]
		const result = compareAttributionAccuracy(requests, labels)
		expect(result.complete).toBe(true)
		expect(result.problems).toEqual([])
		expect(result.reference).toEqual(bucket(["req-ok"], 1_000_000_000n))
		expect(result.correct).toEqual(bucket(["req-ok"], 1_000_000_000n))
		// Null-labeled spending is wrong only: never missed, never in the reference.
		expect(result.wrong).toEqual(bucket(["req-null"], 2_500_000_000n))
		expect(result.missed).toEqual(bucket([], 0n))
		expect(result.metrics).toEqual(percentages(1_000_000_000n, 1_000_000_000n, 2_500_000_000n))
		expect(result.metrics.wrongAssignmentPercent).toBe("71.428571428")
	})

	it("never mutates its inputs", () => {
		const mixed = mixedFixture()
		const mixedRequests = JSON.parse(JSON.stringify(mixed.requests))
		const mixedLabels = JSON.parse(JSON.stringify(mixed.labels))
		compareAttributionAccuracy(mixed.requests, mixed.labels)
		expect(mixed.requests).toStrictEqual(mixedRequests)
		expect(mixed.labels).toStrictEqual(mixedLabels)

		const requests = [row("req-a", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" })]
		// Deliberately malformed runtime input must not be rewritten either.
		const malformed = [null, { requestId: "req-a", expectedPullRequestId: PR1 }, "nope"]
		const requestsSnapshot = JSON.parse(JSON.stringify(requests))
		const malformedSnapshot = JSON.parse(JSON.stringify(malformed))
		compareAttributionAccuracy(requests, malformed)
		expect(requests).toStrictEqual(requestsSnapshot)
		expect(malformed).toStrictEqual(malformedSnapshot)
	})

	it("preserves bucket invariants and deterministic problem order on a mixed fixture", () => {
		const { requests, labels } = mixedFixture()
		const result = compareAttributionAccuracy(requests, labels)
		expect(result.complete).toBe(false)
		expect(result.metrics).toEqual(noPercentages)
		// Known subtotals stay exact even though the result is incomplete.
		expect(result.reference).toEqual(bucket(["req-correct", "req-shared", "req-unmerged", "req-wrong"], 3_750_000_000n))
		expect(result.correct).toEqual(bucket(["req-correct"], 1_000_000_000n))
		expect(result.wrong).toEqual(bucket(["req-nullconf", "req-wrong"], 5_000_000_000n))
		expect(result.missed).toEqual(bucket(["req-shared", "req-unmerged", "req-wrong"], 2_750_000_000n))
		expect(result.correct.knownCostNanos + result.missed.knownCostNanos).toBe(result.reference.knownCostNanos)
		// Every valid labeled reference request is counted exactly once across correct and missed.
		expect([...result.correct.requestIds, ...result.missed.requestIds].sort()).toEqual(result.reference.requestIds)
		// Problem order is pinned end to end: label-input duplicates, then stage-3 checks in label
		// order, then report-row problems in row order (0-based indices 8 and 9).
		expect(result.problems).toEqual([
			{ kind: "duplicate-label", requestId: "req-dup", detail: expect.stringMatching(/\S/) },
			{ kind: "unpriced-request", requestId: "req-unpriced", detail: expect.stringContaining("missing") },
			{ kind: "missing-report-row", requestId: "req-ghost", detail: expect.stringMatching(/\S/) },
			{ kind: "invalid-report-row", requestId: null, detail: expect.stringContaining("8") },
			{ kind: "invalid-report-row", requestId: null, detail: expect.stringContaining("9") },
			{ kind: "unlabelled-request", requestId: "req-nolabel", detail: expect.stringMatching(/\S/) },
		])
	})

	it("flags object-valued unpriced fields as unpriced-request instead of crashing", () => {
		const requests = [
			// Deliberately type-invalid runtime input; the row must be flagged, never crash.
			{
				...row("r1", { allocation: "pull-request", pullRequestIds: [PR1] }),
				knownCostUsd: { toString: null },
			},
			// Same defect class: the detail also interpolates the raw priceStatus.
			{
				...row("r2", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" }),
				priceStatus: { toString: null },
			},
			// Control: a fully valid priced row, confidently on its expected PR.
			row("r3", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "0.500000000" }),
		]
		const labels = [label("r1", PR1), label("r2", PR1), label("r3", PR1)]
		const result = compareAttributionAccuracy(requests, labels)
		expect(result.complete).toBe(false)
		// r3 keeps the reference positive, so null metrics pin the incomplete rule, not a zero denominator.
		expect(result.metrics).toEqual(noPercentages)
		expect(result.problems).toEqual([
			{ kind: "unpriced-request", requestId: "r1", detail: expect.stringMatching(/\S/) },
			{ kind: "unpriced-request", requestId: "r2", detail: expect.stringMatching(/\S/) },
		])
		expect(result.reference).toEqual(bucket(["r3"], 500_000_000n))
		expect(result.correct).toEqual(bucket(["r3"], 500_000_000n))
		expect(result.wrong).toEqual(bucket([], 0n))
		expect(result.missed).toEqual(bucket([], 0n))
	})

	it("matches full-form report keys exactly, so hand-typed short forms score wrong and missed", () => {
		// Saved reports key PRs as provider:host/owner/repo#number (see storedPullRequest in costs.ts),
		// while the doc once taught the short provider:owner/repo#number form. That short form passes
		// the deliberately loose validation regex but never string-equals the real report key.
		const full7 = "github:github.com/acme/api#7"
		const full8 = "github:github.com/acme/api#8"
		const short8 = "github:acme/api#8"
		const requests = [
			row("req-full", { allocation: "pull-request", pullRequestIds: [full7], knownCostUsd: "1.000000000" }),
			row("req-short", { allocation: "pull-request", pullRequestIds: [full8], knownCostUsd: "2.000000000" }),
		]
		const labels = [label("req-full", full7), label("req-short", short8)]
		const result = compareAttributionAccuracy(requests, labels)
		// The trap: no validation problem is raised — the short form is regex-valid, just never equal.
		expect(result.complete).toBe(true)
		expect(result.problems).toEqual([])
		expect(result.reference).toEqual(bucket(["req-full", "req-short"], 3_000_000_000n))
		expect(result.correct).toEqual(bucket(["req-full"], 1_000_000_000n))
		// The same req-short spending lands in both wrong and missed.
		expect(result.wrong).toEqual(bucket(["req-short"], 2_000_000_000n))
		expect(result.missed).toEqual(bucket(["req-short"], 2_000_000_000n))
		// Truncated integer math: 1/3 and 2/3 at nine decimals, pinned as literals.
		expect(result.metrics).toEqual(percentages(3_000_000_000n, 1_000_000_000n, 2_000_000_000n))
		expect(result.metrics.correctCoveragePercent).toBe("33.333333333")
		expect(result.metrics.wrongAssignmentPercent).toBe("66.666666666")
		expect(result.correct.knownCostNanos + result.missed.knownCostNanos).toBe(result.reference.knownCostNanos)
	})
})
