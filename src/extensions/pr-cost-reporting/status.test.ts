import { describe, expect, it } from "vitest"
import type { PendingRepository, ReportingState } from "./queue.js"
import { accountKey, repositoryKey } from "./snapshot.js"
import { limitNoticeTexts, statusText } from "./status.js"

const now = Date.UTC(2026, 9, 8, 12)
const account = {
	apiUrl: "https://api.example",
	organizationId: "11111111-1111-4111-8111-111111111111",
	userId: "22222222-2222-4222-8222-222222222222",
}
function entry(id: string, fields: Partial<PendingRepository> = {}): [string, PendingRepository] {
	const repository = { provider: "github" as const, host: "github.com", id, name: `example/${id}` }
	return [
		`${accountKey(account)}:${repositoryKey(repository)}`,
		{ account, repository, revision: "1", requestHashes: [], attempts: 0, retryAt: 0, ...fields },
	]
}
const pending = {
	schemaVersion: 1 as const,
	producerId: "33333333-3333-4333-8333-333333333333",
	revision: "2",
	generatedAt: new Date(now).toISOString(),
	repository: { provider: "github" as const, host: "github.com", id: "1" },
	pullRequests: [],
	requests: [],
	coverage: { observedRequests: 0, unpricedRequests: 0, historyComplete: true },
}
const state = (entries: [string, PendingRepository][], fields: Partial<ReportingState> = {}): ReportingState => ({
	version: 1,
	enabled: true,
	followsTelemetry: true,
	producerId: "44444444-4444-4444-8444-444444444444",
	entries: Object.fromEntries(entries),
	...fields,
})

describe("/pr-reporting status", () => {
	it("explains a session that does not upload and repositories waiting for their upload window", () => {
		const status = statusText(
			state([
				entry("1", { pending, uploadedAt: now - 60_000, lastAcknowledgedAt: new Date(now).toISOString() }),
				entry("2", { pending, uploadedAt: now - 60_000, urgent: true }),
			]),
			"CI environment (GITHUB_ACTIONS)",
			now,
		)
		expect(status).toEqual({
			text: [
				"PR reporting: on (SaaS default)",
				"Uploads are skipped in this session: CI environment (GITHUB_ACTIONS). Local attribution continues.",
				"Queued repositories: 2 (1 waiting for the 5-minute upload window)",
				"Acknowledged repositories: 1",
			].join("\n"),
			warning: false,
		})
	})
	it("shows account pauses, repository limits and trimmed repositories with their next attempt", () => {
		const limit = {
			scope: "organization" as const,
			limit: "requests" as const,
			current: 50000,
			maximum: 50000,
			at: now,
		}
		const text = statusText(
			state(
				[
					entry("1", {
						pending,
						retryAt: now + 6 * 3_600_000,
						limit: { scope: "producer", limit: "repositories", current: 101, maximum: 100, at: now },
					}),
					entry("2", {
						pending,
						retryAt: now + 5 * 3_600_000,
						limit: { scope: "snapshot", limit: "requests", current: 12, maximum: 10, at: now },
						learned: { requests: 9, until: now + 1 },
					}),
					entry("3", { trimmed: 1200 }),
				],
				{ paused: { [accountKey(account)]: { limit, retryAt: now + 30 * 60_000 } } },
			),
			undefined,
			now,
		)
		expect(text.warning).toBe(true)
		expect(text.text.split("\n").slice(3)).toEqual([
			"PR cost reporting paused for this organization: organization limit reached (requests 50000 of 50000). Ask an admin to free space or wait; next try in about 30 min.",
			"example/1: producer limit reached (repositories 101 of 100). Not reported; next try in about 6 h.",
			"example/2: snapshot limit reached (requests 12 of 10). Sending a smaller snapshot in about 5 h.",
			"example/3 is partially reported: 1200 requests left out to fit the upload limits.",
		])
	})
	it("keeps delivery errors visible once", () => {
		const text = statusText(
			state(
				[
					entry("1", { pending, lastError: "PR reporting returned HTTP 503" }),
					entry("2", { pending, lastError: "PR reporting returned HTTP 503" }),
				],
				{
					error: "PR reporting held 1 repository snapshot(s) because earlier evidence is missing",
				},
			),
			undefined,
			now,
		).text
		expect(text.split("\n").slice(3)).toEqual([
			"PR reporting held 1 repository snapshot(s) because earlier evidence is missing",
			"PR reporting returned HTTP 503",
		])
	})
})

describe("one-time limit notices", () => {
	it("names the repository, or its provider identity, and tells account pauses apart", () => {
		expect(
			limitNoticeTexts({
				repositories: [
					{ provider: "github", host: "github.com", id: "1", name: "owner/repo" },
					{ provider: "gitlab", host: "gitlab.example", id: "7" },
				],
				pauses: [
					{ scope: "organization", limit: "requests", at: now },
					{ scope: "organization", limit: "bytes", at: now },
					{ scope: "contributor", at: now },
				],
			}),
		).toEqual([
			"PR cost reporting paused for this organization: limit reached. Ask an admin to free space or wait.",
			"PR cost reporting paused for your account in this organization: limit reached. Ask an admin to free space or wait.",
			"PR costs for owner/repo are partially reported: limit reached. See /pr-reporting status.",
			"PR costs for gitlab.example repository 7 are partially reported: limit reached. See /pr-reporting status.",
		])
	})
})
