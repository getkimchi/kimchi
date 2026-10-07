import { createHash } from "node:crypto"
import * as files from "node:fs/promises"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkPullRequest } from "../pull-request-status/pull-requests.js"
import { calculatePullRequestCosts } from "../work-attribution/costs.js"
import type { WorkRecord } from "../work-attribution/summary.js"
import {
	acknowledgeSnapshot,
	deferSnapshot,
	queueSnapshots,
	readReportingState,
	setReportingEnabled,
	takeReportingNotice,
} from "./queue.js"
import { accountKey, buildSnapshots, type RepositorySnapshot, repositoryKey } from "./snapshot.js"

const account = {
	apiUrl: "https://api.example",
	organizationId: "11111111-1111-4111-8111-111111111111",
	userId: "22222222-2222-4222-8222-222222222222",
}
const requestId = "33333333-3333-4333-8333-333333333333"
const otherRequestId = "44444444-4444-4444-8444-444444444444"
const snapshot = (requestIds: string[] = []): RepositorySnapshot => ({
	account,
	content: {
		repository: { provider: "github", host: "github.com", id: "42" },
		pullRequests: [],
		requests: requestIds.map((requestId) => ({
			requestId,
			startedAt: "2026-10-04T12:00:00Z",
			billingRecordIds: [],
			allocation: { kind: "unlinked", pullRequestIds: [], method: "native" },
		})),
		coverage: { observedRequests: requestIds.length, unpricedRequests: requestIds.length, historyComplete: true },
	},
})
let directory: string
vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof files>()) }))
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "kimchi-reporting-"))
	vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "true")
})
afterEach(async () => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	await rm(directory, { recursive: true, force: true })
})

describe("durable reporting queue", () => {
	it.each([
		true,
		false,
	])("reopens an old queue without resetting its explicit choice or request history (%s)", async (enabled) => {
		const previous = snapshot([requestId])
		const key = `${accountKey(account)}:${repositoryKey(previous.content.repository)}`
		const producerId = "55555555-5555-4555-8555-555555555555"
		const legacy = {
			version: 1,
			enabled,
			producerId,
			entries: {
				[key]: {
					account,
					repository: previous.content.repository,
					revision: "7",
					requestHashes: [createHash("sha256").update(requestId).digest("hex")],
					pending: {
						...previous.content,
						schemaVersion: 1,
						producerId,
						revision: "7",
						generatedAt: "2026-10-04T12:00:00Z",
					},
					pendingDigest: "old-digest",
					attempts: 2,
					retryAt: 100,
				},
			},
		}
		await files.mkdir(join(directory, "pr-cost-reporting"), { recursive: true })
		await writeFile(join(directory, "pr-cost-reporting/state.json"), JSON.stringify(legacy))
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", String(!enabled))
		expect(await readReportingState(directory)).toEqual(legacy)
		await setReportingEnabled(directory, true)
		const next = await queueSnapshots(directory, [snapshot([requestId, otherRequestId])], true)
		expect(next.producerId).toBe(producerId)
		expect(next.entries[key].revision).toBe("8")
		expect(next.entries[key].requestHashes).toHaveLength(2)
		await acknowledgeSnapshot(directory, key, "7", {
			status: "accepted",
			revision: "7",
			receivedAt: "2026-10-07T12:00:00Z",
		})
		expect((await readReportingState(directory)).entries[key].pending?.revision).toBe("8")
	})
	it("allows deliberate window expiry while still holding a missing source request", async () => {
		const initial = await queueSnapshots(directory, [snapshot([requestId, otherRequestId])], true)
		const [key] = Object.keys(initial.entries)
		await acknowledgeSnapshot(directory, key, "1", {
			status: "accepted",
			revision: "1",
			receivedAt: new Date().toISOString(),
		})
		const missing = await queueSnapshots(directory, [snapshot([otherRequestId])], true)
		expect(missing.entries[key].held).toBe(true)
		const expired = snapshot([otherRequestId])
		expired.observedRequestIds = [requestId, otherRequestId]
		const queued = await queueSnapshots(directory, [expired], true)
		expect(queued.entries[key].held).toBeUndefined()
		expect(queued.entries[key].pending?.requests.map((request) => request.requestId)).toEqual([otherRequestId])
		expect(queued.entries[key].requestHashes).toHaveLength(2)
		await acknowledgeSnapshot(directory, key, "2", {
			status: "accepted",
			revision: "2",
			receivedAt: new Date().toISOString(),
		})
		expect((await readReportingState(directory)).entries[key].requestHashes).toHaveLength(1)
	})
	it("claims the default-on notice once across concurrent sessions", async () => {
		expect((await Promise.all([takeReportingNotice(directory), takeReportingNotice(directory)])).sort()).toEqual([
			false,
			true,
		])
		expect(await takeReportingNotice(directory)).toBe(false)
	})
	it("follows SaaS uploads by default after the queue is saved and reopened", async () => {
		expect((await readReportingState(directory)).enabled).toBe(true)
		await queueSnapshots(directory, [snapshot([requestId])])
		const original = await readReportingState(directory)
		expect(Object.values(original.entries)[0].pending?.requests[0].requestId).toBe(requestId)
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "false")
		expect((await readReportingState(directory)).enabled).toBe(false)
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "true")
		expect(await readReportingState(directory)).toEqual(original)
	})
	it.each([true, false])("preserves an explicit reporting choice (%s) when SaaS uploads change", async (enabled) => {
		await setReportingEnabled(directory, enabled)
		for (const telemetry of ["false", "true"]) {
			vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", telemetry)
			expect((await readReportingState(directory)).enabled).toBe(enabled)
		}
	})
	it.each([
		{ acknowledged: true, optOut: false },
		{ acknowledged: true, optOut: true },
		{ acknowledged: false, optOut: false },
		{ acknowledged: false, optOut: true },
	])("holds a pending migration after evidence loss ($acknowledged, opt-out=$optOut)", async ({
		acknowledged,
		optOut,
	}) => {
		await setReportingEnabled(directory, true)
		await queueSnapshots(directory, [snapshot([requestId])], true)
		const [key, original] = Object.entries((await readReportingState(directory)).entries)[0]
		if (acknowledged)
			await acknowledgeSnapshot(directory, key, "1", {
				status: "accepted",
				revision: "1",
				receivedAt: new Date().toISOString(),
			})
		const moved = snapshot([requestId])
		moved.content.repository.id = "43"
		await queueSnapshots(directory, [moved], true)
		expect((await readReportingState(directory)).entries[key].pending?.requests).toEqual([])
		if (optOut) {
			await setReportingEnabled(directory, false)
			await acknowledgeSnapshot(directory, key, "2", {
				status: "accepted",
				revision: "2",
				receivedAt: new Date().toISOString(),
			})
			expect(JSON.stringify(await readReportingState(directory))).not.toContain(requestId)
			await setReportingEnabled(directory, true)
		}
		// A restarted process sees only an independent repository; neither migration payload was acknowledged.
		const healthy = snapshot()
		healthy.content.repository.id = "44"
		await queueSnapshots(directory, [healthy], false)
		const restarted = await readReportingState(directory)
		expect(restarted.entries[key]).toMatchObject({ held: true, requestHashes: original.requestHashes })
		expect(Object.values(restarted.entries).find((entry) => entry.repository.id === "43")?.held).toBe(true)
		expect(Object.values(restarted.entries).find((entry) => entry.repository.id === "44")?.pending).toBeDefined()
		// Restoring that same membership permits the correction, then its matching ACK releases the old hashes.
		await queueSnapshots(directory, [moved, healthy], true)
		const restored = (await readReportingState(directory)).entries[key]
		expect(restored.held).toBeUndefined()
		expect(restored.pending?.requests).toEqual([])
		await acknowledgeSnapshot(directory, key, restored.revision, {
			status: acknowledged ? "accepted" : "unchanged",
			revision: restored.revision,
			receivedAt: new Date().toISOString(),
		})
		expect((await readReportingState(directory)).entries[key].requestHashes).toEqual([])
	})
	it("retains every possibly delivered membership when replacement acknowledgements are lost or late", async () => {
		await setReportingEnabled(directory, true)
		await queueSnapshots(directory, [snapshot([requestId])], true)
		const [key] = Object.keys((await readReportingState(directory)).entries)
		const moved = snapshot([requestId])
		moved.content.repository.id = "43"
		await queueSnapshots(directory, [snapshot([otherRequestId]), moved], true)
		moved.content.requests.push(snapshot([otherRequestId]).content.requests[0])
		moved.content.coverage = { observedRequests: 2, unpricedRequests: 2, historyComplete: true }
		await queueSnapshots(directory, [moved], true)
		await acknowledgeSnapshot(directory, key, "2", {
			status: "accepted",
			revision: "2",
			receivedAt: new Date().toISOString(),
		})
		const queued = (await readReportingState(directory)).entries[key]
		expect(queued.pending?.revision).toBe("3")
		expect(queued.requestHashes).toHaveLength(2)
		await queueSnapshots(directory, [], false)
		expect((await readReportingState(directory)).entries[key].held).toBe(true)
	})
	it("resends a same-membership correction after opt-out discarded an unacknowledged replacement", async () => {
		await setReportingEnabled(directory, true)
		const original = snapshot([requestId])
		await queueSnapshots(directory, [original], true)
		const [key] = Object.keys((await readReportingState(directory)).entries)
		await acknowledgeSnapshot(directory, key, "1", {
			status: "accepted",
			revision: "1",
			receivedAt: new Date().toISOString(),
		})
		const correction = snapshot([requestId])
		correction.content.requests[0].allocation.kind = "unknown"
		await queueSnapshots(directory, [correction], true)
		// Revision 2 may have reached the server before consent was revoked and its ACK was lost.
		await setReportingEnabled(directory, false)
		await setReportingEnabled(directory, true)
		await queueSnapshots(directory, [original], true)
		await acknowledgeSnapshot(directory, key, "2", {
			status: "accepted",
			revision: "2",
			receivedAt: new Date().toISOString(),
		})
		const current = (await readReportingState(directory)).entries[key]
		expect(current.pending).toMatchObject({ revision: "3", requests: [{ allocation: { kind: "unlinked" } }] })
		expect(current.requestHashes).toHaveLength(1)
	})
	it("does not shrink membership when a stale acknowledgement only establishes a higher server revision", async () => {
		await setReportingEnabled(directory, true)
		await queueSnapshots(directory, [snapshot([requestId])], true)
		const [key, original] = Object.entries((await readReportingState(directory)).entries)[0]
		const moved = snapshot([requestId])
		moved.content.repository.id = "43"
		await queueSnapshots(directory, [moved], true)
		await acknowledgeSnapshot(directory, key, "2", {
			status: "stale",
			revision: "8",
			receivedAt: new Date().toISOString(),
		})
		await queueSnapshots(directory, [], false)
		expect((await readReportingState(directory)).entries[key]).toMatchObject({
			revision: "8",
			requestHashes: original.requestHashes,
			held: true,
		})
		await queueSnapshots(directory, [moved], true)
		expect((await readReportingState(directory)).entries[key].pending?.revision).toBe("9")
	})
	it("holds an oversized repository without truncating it or blocking an independent snapshot", async () => {
		await setReportingEnabled(directory, true)
		const oversized = snapshot()
		oversized.content.requests.push({
			requestId: "33333333-3333-4333-8333-333333333333",
			startedAt: "2026-10-04T12:00:00Z",
			billingRecordIds: Array.from(
				{ length: 9 },
				(_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
			),
			allocation: { kind: "unlinked", pullRequestIds: [], method: "native" },
		})
		oversized.content.coverage.observedRequests = 1
		const healthy = snapshot()
		healthy.content.repository.id = "43"
		await queueSnapshots(directory, [oversized, healthy])
		const state = await readReportingState(directory)
		expect(Object.values(state.entries).map((entry) => entry.repository.id)).toEqual(["43"])
		expect(state.error).toContain("limits")
	})
	it("keeps the retry deadline when new source evidence replaces a rate-limited snapshot", async () => {
		await setReportingEnabled(directory, true)
		await queueSnapshots(directory, [snapshot()])
		const [key] = Object.keys((await readReportingState(directory)).entries)
		const retryAt = Date.now() + 120000
		await deferSnapshot(directory, key, "1", retryAt, "PR reporting returned HTTP 429")
		const changed = snapshot()
		changed.content.coverage.historyComplete = false
		await queueSnapshots(directory, [changed])
		expect((await readReportingState(directory)).entries[key]).toMatchObject({ revision: "2", retryAt, attempts: 1 })
	})
	it("leaves the last durable revision unchanged when fsync fails", async () => {
		await setReportingEnabled(directory, true)
		const before = await readReportingState(directory)
		const originalOpen = files.open
		vi.spyOn(files, "open").mockImplementation(async (...args) => {
			const file = await originalOpen(...args)
			if (String(args[0]).endsWith(".tmp")) vi.spyOn(file, "sync").mockRejectedValue(new Error("disk unavailable"))
			return file
		})
		await expect(queueSnapshots(directory, [snapshot()])).rejects.toThrow("disk unavailable")
		expect(await readReportingState(directory)).toEqual(before)
	})
	it("replaces an accepted inventory with a higher-revision empty snapshot after local removal", async () => {
		await setReportingEnabled(directory, true)
		const original = snapshot()
		original.content.requests.push({
			requestId: "33333333-3333-4333-8333-333333333333",
			startedAt: "2026-10-04T12:00:00Z",
			billingRecordIds: [],
			allocation: { kind: "unlinked", pullRequestIds: [], method: "native" },
		})
		original.content.coverage = { observedRequests: 1, unpricedRequests: 1, historyComplete: true }
		await queueSnapshots(directory, [original])
		const [key] = Object.keys((await readReportingState(directory)).entries)
		await acknowledgeSnapshot(directory, key, "1", {
			status: "accepted",
			revision: "1",
			receivedAt: new Date().toISOString(),
		})
		const moved = structuredClone(original)
		moved.content.repository.id = "43"
		await queueSnapshots(directory, [moved], true)
		expect((await readReportingState(directory)).entries[key].pending).toMatchObject({
			revision: "2",
			requests: [],
			pullRequests: [],
		})
	})
	it("holds an acknowledged group's missing request after restart while another group progresses", async () => {
		await setReportingEnabled(directory, true)
		const original = snapshot()
		original.content.requests.push({
			requestId: "33333333-3333-4333-8333-333333333333",
			startedAt: "2026-10-04T12:00:00Z",
			billingRecordIds: [],
			allocation: { kind: "unlinked", pullRequestIds: [], method: "native" },
		})
		original.content.coverage = { observedRequests: 1, unpricedRequests: 1, historyComplete: true }
		await queueSnapshots(directory, [original])
		const [key] = Object.keys((await readReportingState(directory)).entries)
		await acknowledgeSnapshot(directory, key, "1", {
			status: "accepted",
			revision: "1",
			receivedAt: new Date().toISOString(),
		})
		const incomplete = snapshot()
		incomplete.content.coverage.historyComplete = false
		const healthy = snapshot()
		healthy.content.repository.id = "44"
		await queueSnapshots(directory, [incomplete, healthy])
		const restarted = await readReportingState(directory)
		expect(restarted.entries[key]).toMatchObject({ revision: "1", held: true })
		expect(restarted.entries[key].pending).toBeUndefined()
		expect(Object.values(restarted.entries).find((entry) => entry.repository.id === "44")?.pending).toBeDefined()
		const corrected = structuredClone(original)
		corrected.content.requests[0].allocation.kind = "unknown"
		corrected.content.coverage.historyComplete = false
		await queueSnapshots(directory, [corrected, healthy])
		expect((await readReportingState(directory)).entries[key].pending?.revision).toBe("2")
	})
	it("fails closed on damaged durable state instead of resetting its producer or revisions", async () => {
		await setReportingEnabled(directory, true)
		await writeFile(join(directory, "pr-cost-reporting", "state.json"), "{broken")
		await expect(queueSnapshots(directory, [snapshot()])).rejects.toThrow("unreadable")
		expect(await readFile(join(directory, "pr-cost-reporting", "state.json"), "utf8")).toBe("{broken")
	})
	it("defaults off while SaaS uploads are disabled and starts collecting when they are enabled", async () => {
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "false")
		await queueSnapshots(directory, [snapshot()])
		expect((await readReportingState(directory)).entries).toEqual({})
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "true")
		await queueSnapshots(directory, [snapshot([requestId])])
		expect(Object.values((await readReportingState(directory)).entries)[0]?.pending?.requests[0].requestId).toBe(
			requestId,
		)
	})
	it("replaces pending snapshots, survives restart and ignores a late acknowledgement", async () => {
		await setReportingEnabled(directory, true)
		await queueSnapshots(directory, [snapshot()])
		const before = await readReportingState(directory)
		const [key, first] = Object.entries(before.entries)[0]
		expect(first.pending?.revision).toBe("1")
		const next = snapshot()
		next.content.coverage.historyComplete = false
		await queueSnapshots(directory, [next])
		await acknowledgeSnapshot(directory, key, "1", {
			status: "accepted",
			revision: "1",
			receivedAt: new Date().toISOString(),
		})
		const after = await readReportingState(directory)
		expect(after.producerId).toBe(before.producerId)
		expect(after.entries[key].pending?.revision).toBe("2")
		expect(
			JSON.parse(await readFile(join(directory, "pr-cost-reporting", "state.json"), "utf8")).entries[key].pending
				.revision,
		).toBe("2")
	})
	it("deduplicates concurrent captures and deletes payloads on opt-out without resetting revisions", async () => {
		await setReportingEnabled(directory, true)
		await Promise.all([queueSnapshots(directory, [snapshot()]), queueSnapshots(directory, [snapshot()])])
		const [key] = Object.keys((await readReportingState(directory)).entries)
		expect((await readReportingState(directory)).entries[key].revision).toBe("1")
		await setReportingEnabled(directory, false)
		expect((await readReportingState(directory)).entries[key].pending).toBeUndefined()
		await setReportingEnabled(directory, true)
		await queueSnapshots(directory, [snapshot()])
		expect((await readReportingState(directory)).entries[key].pending?.revision).toBe("2")
	})
	it("separates accounts and advances beyond a server revision without acknowledging newer content", async () => {
		await setReportingEnabled(directory, true)
		const other = snapshot()
		other.account = { ...account, userId: "33333333-3333-4333-8333-333333333333" }
		await queueSnapshots(directory, [snapshot(), other])
		const [key] = Object.keys((await readReportingState(directory)).entries)
		await acknowledgeSnapshot(directory, key, "1", {
			status: "stale",
			revision: "8",
			receivedAt: new Date().toISOString(),
		})
		await queueSnapshots(directory, [snapshot(), other])
		const state = await readReportingState(directory)
		expect(Object.keys(state.entries)).toHaveLength(2)
		expect(state.entries[key].pending?.revision).toBe("9")
	})
})

describe("unusable provider metadata for one PR", () => {
	const at = (minutes: number) => new Date(Date.UTC(2026, 9, 2, 10, minutes)).toISOString()
	const mergeRequest = (number: number, overrides: Partial<WorkPullRequest> = {}): WorkPullRequest => ({
		provider: "gitlab",
		id: String(9000 + number),
		repositoryId: "42",
		host: "gitlab.com",
		repository: "team/repo",
		number,
		url: `https://gitlab.com/team/repo/-/merge_requests/${number}`,
		state: "open",
		headSha: "a".repeat(40),
		mergeCommitSha: null,
		mergedAt: null,
		closedAt: null,
		checkedAt: at(15),
		...overrides,
	})
	const request = (id: string, workId: string, minutes: number): WorkRecord => ({
		version: 1,
		type: "request",
		workId,
		sessionId: workId,
		requestId: id,
		recordedAt: at(minutes),
		scope: { account, repository: "/repo/.git" },
	})
	const commit = (workId: string, sha: string, pullRequests: WorkPullRequest[]): WorkRecord => ({
		version: 1,
		type: "commit",
		workId,
		sessionId: workId,
		sha: sha.repeat(40),
		repository: "/repo/.git",
		worktree: "/repo",
		recordedAt: at(20),
		pullRequests,
	})
	async function scan(rows: WorkRecord[]) {
		const built = buildSnapshots(
			rows,
			calculatePullRequestCosts(rows, []),
			new Map([["/repo/.git", { provider: "gitlab" as const, host: "gitlab.com", id: "42", name: "team/repo" }]]),
			true,
		)
		return queueSnapshots(directory, built.snapshots, !built.incomplete)
	}

	it("keeps reporting other MRs in a repository after GitLab marks one MR merged without merged_at", async () => {
		const first = await scan([request(requestId, "work-a", 10), commit("work-a", "a", [mergeRequest(7)])])
		const [key] = Object.keys(first.entries)
		await acknowledgeSnapshot(directory, key, "1", { status: "accepted", revision: "1", receivedAt: at(16) })
		// GitLab can report state "merged" while omitting merged_at; meanwhile unrelated work lands on MR !8.
		const next = await scan([
			request(requestId, "work-a", 10),
			commit("work-a", "a", [mergeRequest(7, { state: "merged", checkedAt: at(40) })]),
			request(otherRequestId, "work-b", 41),
			commit("work-b", "b", [mergeRequest(8, { checkedAt: at(42) })]),
		])
		expect(next.entries[key].held).toBeUndefined()
		expect(next.entries[key].pending?.requests.map((row) => row.requestId).sort()).toEqual(
			[requestId, otherRequestId].sort(),
		)
	})
})
