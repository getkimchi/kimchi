import { describe, expect, it } from "vitest"
import type { readOutboxStatus } from "./ledger/outbox.js"
import type { ReportingState } from "./queue.js"
import { statusText } from "./status.js"

const now = Date.UTC(2026, 9, 8, 12)
const state = (fields: Partial<ReportingState> = {}): ReportingState => ({
	version: 1,
	enabled: true,
	followsTelemetry: true,
	producerId: "44444444-4444-4444-8444-444444444444",
	...fields,
})
type OutboxStatus = ReturnType<typeof readOutboxStatus>[number]
const outbox = (fields: Partial<OutboxStatus> = {}): OutboxStatus => ({
	accountKey: "original-account",
	pending: 0,
	sendable: 0,
	blocked: 0,
	acknowledged: 0,
	lastAcknowledgedAt: null,
	batches: 0,
	firstBatchId: null,
	retry: undefined,
	...fields,
})
const retry = (error?: string) => ({
	batchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	attempts: 1,
	retryAt: now + 60_000,
	...(error ? { error } : {}),
})

describe("/pr-reporting status", () => {
	it("shows event delivery and retry failures", () => {
		const status = statusText(state({ enabled: false, error: undefined }), undefined, now, [
			outbox({
				pending: 3,
				sendable: 2,
				blocked: 1,
				acknowledged: 7,
				lastAcknowledgedAt: now - 1000,
				batches: 1,
				firstBatchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				retry: retry("PR cost event upload returned HTTP 503"),
			}),
		])
		expect(status.warning).toBe(true)
		const text = status.text.replace(/\n\s+/g, " ")
		expect(text).toContain("PR cost event upload returned HTTP 503")
		expect(text).toContain("1 event blocked; retained locally.")
		expect(text).toContain("Events         3 queued · 7 acknowledged")
		expect(text).toContain("1 frozen batch awaiting acknowledgement")
		expect(text).toContain("Event retry    in about 1 min")
		expect(text).toContain("Last event ACK 2026-10-08T11:59:59.000Z")
	})
	it("shows a persisted batch even when no pending event rows remain", () => {
		const status = statusText(state(), undefined, now, [
			outbox({ batches: 1, firstBatchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
		])
		expect(status.text).toContain("1 frozen batch awaiting acknowledgement")
		expect(status.warning).toBe(false)
	})
	it("states the setting plainly", () => {
		expect(statusText(state(), undefined, now)).toEqual({
			text: "PR reporting   Enabled (SaaS default)",
			warning: false,
		})
		expect(statusText(state({ enabled: false, followsTelemetry: undefined }), undefined, now)).toEqual({
			text: "PR reporting   Disabled (explicit choice)",
			warning: false,
		})
	})
	it("leads with delivery problems, each shown once, and warns", () => {
		expect(
			statusText(state({ error: "PR cost event upload returned HTTP 503" }), undefined, now, [
				outbox({ pending: 2, sendable: 2, retry: retry("PR cost event upload returned HTTP 503") }),
				outbox({ accountKey: "other-account", pending: 1, sendable: 1, retry: retry() }),
			]),
		).toEqual({
			text: [
				"Delivery problems",
				"- PR cost event upload returned HTTP 503",
				"- A previous PR cost event upload failed",
				"",
				"PR reporting   Enabled (SaaS default)",
				"Events         3 queued · 0 acknowledged",
				"Event retry    in about 1 min",
			].join("\n"),
			warning: true,
		})
	})
	it("explains a session that does not upload", () => {
		expect(statusText(state(), "CI environment (GITHUB_ACTIONS)", now)).toEqual({
			text: [
				"PR reporting   Enabled (SaaS default)",
				"This session   No uploads; local attribution continues",
				"               Reason: CI environment (GITHUB_ACTIONS)",
			].join("\n"),
			warning: false,
		})
	})
	it("fits a 60-column terminal with every section shown", () => {
		const { text } = statusText(
			state({
				error:
					"PR reporting could not capture a complete inventory; previous reports were retained. Some PR cost events are waiting for complete original evidence",
			}),
			"benchmark run (KIMCHI_INFRA_BREAKER_THRESHOLD)",
			now,
			[
				outbox({
					pending: 123_456,
					blocked: 31_999,
					acknowledged: 1_234_567,
					lastAcknowledgedAt: now,
					batches: 12,
					retry: retry("PR reporting is not allowed for this API key (HTTP 403)"),
				}),
			],
		)
		// The TUI pads notifications by one column on each side.
		expect(text.split("\n").filter((line) => line.length > 58)).toEqual([])
		expect(text).toContain(
			[
				"This session   No uploads; local attribution continues",
				"               Reason: benchmark run",
				"               (KIMCHI_INFRA_BREAKER_THRESHOLD)",
			].join("\n"),
		)
	})
})
