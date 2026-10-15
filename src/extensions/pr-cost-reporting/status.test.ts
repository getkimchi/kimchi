import { homedir } from "node:os"
import { join } from "node:path"
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
	it("states the setting plainly and counts repositories on one line", () => {
		expect(statusText(state([]), undefined, now)).toEqual({
			text: ["PR reporting   Enabled (SaaS default)", "Repositories   0 queued · 0 acknowledged"].join("\n"),
			warning: false,
		})
	})
	it("states an explicit opt-out with the repositories acknowledged before it", () => {
		const acknowledged = { lastAcknowledgedAt: new Date(now).toISOString() }
		expect(
			statusText(
				state([entry("1", acknowledged), entry("2", acknowledged)], { enabled: false, followsTelemetry: undefined }),
				undefined,
				now,
			),
		).toEqual({
			text: ["PR reporting   Disabled (explicit choice)", "Repositories   0 queued · 2 acknowledged"].join("\n"),
			warning: false,
		})
	})
	it("reports incomplete history as information, because the other requests are still reported", () => {
		expect(
			statusText(
				state([entry("1", { pending })], { followsTelemetry: undefined, skippedRequests: 3693 }),
				undefined,
				now,
			),
		).toEqual({
			text: [
				"PR reporting   Enabled (explicit choice)",
				"Repositories   1 queued · 0 acknowledged",
				"",
				"History coverage incomplete",
				"  3,693 requests skipped without original account or",
				"  repository evidence. Other requests are still reported.",
			].join("\n"),
			warning: false,
		})
	})
	it("leads with delivery problems, each shown once, and warns", () => {
		expect(
			statusText(
				state(
					[
						entry("1", { pending, lastError: "PR reporting returned HTTP 503" }),
						entry("2", { pending, lastError: "PR reporting returned HTTP 503" }),
					],
					{ error: "PR reporting held 1 repository snapshot(s) because earlier evidence is missing" },
				),
				undefined,
				now,
			),
		).toEqual({
			text: [
				"Delivery problems",
				"- PR reporting held 1 repository snapshot(s) because",
				"  earlier evidence is missing",
				"- PR reporting returned HTTP 503",
				"",
				"PR reporting   Enabled (SaaS default)",
				"Repositories   2 queued · 0 acknowledged",
			].join("\n"),
			warning: true,
		})
	})
	it("names each repository Kimchi could not identify, with the login that fixes a refusal, and warns", () => {
		expect(
			statusText(
				state([], {
					blockedRepositories: [
						{
							repository: "/work/app/.git",
							reason: "denied",
							provider: "gitlab",
							message:
								"GitLab team/app could not find this repository, commit or pull request. It may require authentication.",
						},
						{ repository: "/work/tool/.git", reason: "failed", message: "GitHub lookup timed out. Kimchi will retry." },
					],
					unsupportedRepositories: 2,
				}),
				undefined,
				now,
			),
		).toEqual({
			text: [
				"Repositories not reported",
				"- /work/app: GitLab team/app could not find this",
				"  repository, commit or pull request. It may require",
				"  authentication. Run glab auth login or set GITLAB_TOKEN.",
				"- /work/tool: GitHub lookup timed out. Kimchi will retry.",
				"",
				"PR reporting   Enabled (SaaS default)",
				"Repositories   0 queued · 0 acknowledged",
				"               2 not reported: no GitHub or GitLab remote",
			].join("\n"),
			warning: true,
		})
	})
	it("shows a home-directory repository from ~ and the GitHub login for a GitHub refusal", () => {
		const { text } = statusText(
			state([], {
				blockedRepositories: [
					{
						repository: join(homedir(), "code", "app", ".git"),
						reason: "denied",
						provider: "github",
						message: "GitHub authentication failed.",
					},
				],
			}),
			undefined,
			now,
		)
		expect(text.split("\n").slice(0, 3)).toEqual([
			"Repositories not reported",
			"- ~/code/app: GitHub authentication failed. Run gh auth",
			"  login or set GH_TOKEN.",
		])
	})
	it("leaves out repositories it could not report while reporting is off", () => {
		expect(
			statusText(
				state([], {
					enabled: false,
					blockedRepositories: [
						{ repository: "/work/app/.git", reason: "denied", provider: "github", message: "GitHub denied access." },
					],
					unsupportedRepositories: 1,
				}),
				undefined,
				now,
			),
		).toEqual({
			text: ["PR reporting   Disabled (SaaS default)", "Repositories   0 queued · 0 acknowledged"].join("\n"),
			warning: false,
		})
	})
	it("does not call requests held for an unidentified repository unevidenced", () => {
		const { text } = statusText(
			state([], {
				blockedRepositories: [
					{ repository: "/work/app/.git", reason: "failed", message: "GitHub lookup timed out. Kimchi will retry." },
				],
				skippedRequests: 2,
			}),
			undefined,
			now,
		)
		expect(text.split("\n").slice(-4)).toEqual([
			"History coverage incomplete",
			"  2 requests skipped: their repository could not be",
			"  identified, or they lack original account or repository",
			"  evidence. Other requests are still reported.",
		])
	})
	it("counts repositories without a GitHub or GitLab remote as information only", () => {
		expect(statusText(state([], { unsupportedRepositories: 1 }), undefined, now)).toEqual({
			text: [
				"PR reporting   Enabled (SaaS default)",
				"Repositories   0 queued · 0 acknowledged",
				"               1 not reported: no GitHub or GitLab remote",
			].join("\n"),
			warning: false,
		})
	})
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
				"PR reporting   Enabled (SaaS default)",
				"This session   No uploads; local attribution continues",
				"               Reason: CI environment (GITHUB_ACTIONS)",
				"Repositories   2 queued · 1 acknowledged",
				"               1 waiting for the 5-minute upload window",
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
		expect(text).toEqual({
			text: [
				"Delivery problems",
				"- PR cost reporting paused for this organization:",
				"  organization limit reached (requests 50,000 of 50,000).",
				"  Ask an admin to free space or wait.",
				"  Next try in about 30 min.",
				"- example/1: producer limit reached (repositories 101 of",
				"  100). Not reported; next try in about 6 h.",
				"- example/2: snapshot limit reached (requests 12 of 10).",
				"  Sending a smaller snapshot in about 5 h.",
				"- example/3 is partially reported: 1,200 requests left out",
				"  to fit the upload limits.",
				"",
				"PR reporting   Enabled (SaaS default)",
				"Repositories   2 queued · 0 acknowledged",
			].join("\n"),
			warning: true,
		})
	})
	it("fits a 60-column terminal with every section shown", () => {
		const { text } = statusText(
			state(
				[
					entry("1", {
						pending,
						retryAt: now + 3_600_000,
						uploadedAt: now - 60_000,
						limit: { scope: "contributor", limit: "windowedPullRequests", current: 1000, maximum: 1000, at: now },
					}),
					entry("2", { trimmed: 31_999, lastAcknowledgedAt: new Date(now).toISOString() }),
				],
				{
					paused: { [accountKey(account)]: { limit: { scope: "contributor", at: now }, retryAt: now } },
					error:
						"PR reporting held 2 snapshot(s) until queued reports leave room in the local queue. Some queued reports are waiting for their original account endpoint and credentials",
					skippedRequests: 123_456,
				},
			),
			"benchmark run (KIMCHI_INFRA_BREAKER_THRESHOLD)",
			now,
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
