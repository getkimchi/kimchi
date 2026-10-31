import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import * as files from "node:fs/promises"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetOrgPolicyForTests } from "../../org-policy.js"
import { setOrgPolicyForTests } from "../../org-policy.test-utils.js"
import type { WorkPullRequest } from "../pull-request-status/pull-requests.js"
import * as health from "../telemetry/pr-cost.js"
import { calculatePullRequestCosts } from "../work-attribution/costs.js"
import type { WorkRecord } from "../work-attribution/summary.js"
import { backendFor } from "./ledger/records.js"
import { machineFingerprint } from "./machine.js"
import {
	acknowledgeSnapshot,
	deferSnapshot,
	dueLimitNotices,
	freezeSnapshots,
	learnedLimits,
	limitSnapshot,
	queueSnapshots,
	readReportingState,
	reportingProducer,
	setReportingEnabled,
	takeLimitNotices,
	takeReportingNotice,
	withReportingConsent,
} from "./queue.js"
import {
	accountKey,
	buildSnapshots,
	fitSnapshot,
	type RepositorySnapshot,
	repositoryKey,
	SNAPSHOT_LIMITS,
} from "./snapshot.js"

const account = {
	apiUrl: "https://api.example",
	organizationId: "11111111-1111-4111-8111-111111111111",
	userId: "22222222-2222-4222-8222-222222222222",
}
const requestId = "33333333-3333-4333-8333-333333333333"
const otherRequestId = "44444444-4444-4444-8444-444444444444"
const billing = "77777777-7777-4777-8777-777777777777"
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
vi.mock("./machine.js", () => ({ machineFingerprint: vi.fn() }))
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "kimchi-reporting-"))
	vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "true")
	vi.mocked(machineFingerprint).mockResolvedValue(undefined)
})
afterEach(async () => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	await rm(directory, { recursive: true, force: true })
})

describe("org usage-reporting policy", () => {
	afterEach(() => {
		resetOrgPolicyForTests()
	})

	it("creates fresh queues disabled under FORCE_OFF", async () => {
		await setOrgPolicyForTests({ usageReporting: "FORCE_OFF" })
		const state = await readReportingState(directory)
		expect(state.enabled).toBe(false)
	})

	it("re-clamps follow-telemetry queues to disabled on load under FORCE_OFF", async () => {
		await setOrgPolicyForTests({ usageReporting: "FORCE_OFF" })
		await files.mkdir(join(directory, "pr-cost-reporting"), { recursive: true })
		await writeFile(
			join(directory, "pr-cost-reporting/state.json"),
			JSON.stringify({
				version: 1,
				enabled: true,
				followsTelemetry: true,
				producerId: "55555555-5555-4555-8555-555555555555",
				entries: {},
			}),
		)
		const state = await readReportingState(directory)
		expect(state.enabled).toBe(false)
	})

	it("re-clamps follow-telemetry queues to enabled on load under FORCE_ON", async () => {
		await setOrgPolicyForTests({ usageReporting: "FORCE_ON" })
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "false")
		await files.mkdir(join(directory, "pr-cost-reporting"), { recursive: true })
		await writeFile(
			join(directory, "pr-cost-reporting/state.json"),
			JSON.stringify({
				version: 1,
				enabled: false,
				followsTelemetry: true,
				producerId: "55555555-5555-4555-8555-555555555555",
				entries: {},
			}),
		)
		const state = await readReportingState(directory)
		expect(state.enabled).toBe(true)
	})
})

describe("durable reporting queue", () => {
	it("runs an event step beside delayed, held and frozen legacy bodies of its account, but not after opt-out", async () => {
		await setReportingEnabled(directory, true)
		await queueSnapshots(directory, [snapshot([requestId])])
		const path = join(directory, "pr-cost-reporting/state.json")
		const state = await readReportingState(directory)
		for (const entry of Object.values(state.entries)) entry.retryAt = Date.now() + 60_000
		await writeFile(path, JSON.stringify(state))
		const action = vi.fn()
		// A body above the 1 MiB limit in front of the API never drains, so it must not hold events back.
		expect(await withReportingConsent(directory, action, () => {})).toBe(true)
		for (const entry of Object.values(state.entries)) entry.held = true
		await writeFile(path, JSON.stringify(state))
		expect(await withReportingConsent(directory, action, () => {})).toBe(true)
		await freezeSnapshots(directory, () => {})
		expect(backendFor(directory).readNotePage("legacy-pr-cost-snapshots", "", 100)).toHaveLength(1)
		expect(await withReportingConsent(directory, action, () => {})).toBe(true)
		expect(action).toHaveBeenCalledTimes(3)
		await setReportingEnabled(directory, false)
		expect(await withReportingConsent(directory, action, () => {})).toBe(false)
		expect(action).toHaveBeenCalledTimes(3)
	})

	it("holds the state lock during an event step, so an opt-out saves before or after it", async () => {
		await setReportingEnabled(directory, true)
		let locked = false
		await withReportingConsent(
			directory,
			() => {
				locked = existsSync(`${join(directory, "pr-cost-reporting")}.lock`)
			},
			() => {},
		)
		expect(locked).toBe(true)
	})

	it("never runs an event step after its lease or credentials changed", async () => {
		await setReportingEnabled(directory, true)
		const action = vi.fn()
		await expect(
			withReportingConsent(directory, action, () => {
				throw new Error("lease lost")
			}),
		).rejects.toThrow("lease lost")
		expect(action).not.toHaveBeenCalled()
	})

	it("stops an event step when the SaaS uploads it follows are turned off", async () => {
		await setReportingEnabled(directory, true)
		const state = await readReportingState(directory)
		await writeFile(
			join(directory, "pr-cost-reporting/state.json"),
			JSON.stringify({ ...state, followsTelemetry: true }),
		)
		const after = vi.fn()
		await expect(
			withReportingConsent(
				directory,
				(consent) => {
					vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "false")
					consent()
					after()
				},
				() => {},
			),
		).rejects.toThrow("PR reporting is disabled")
		expect(after).not.toHaveBeenCalled()
	})

	it("keeps an empty disabled freeze read-only while explicit consent still persists", async () => {
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "false")
		const state = await freezeSnapshots(directory, () => {})
		expect(state.enabled).toBe(false)
		const path = join(directory, "pr-cost-reporting/state.json")
		await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" })
		await setReportingEnabled(directory, true)
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ enabled: true })
	})

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
	it("queues nothing for a repository whose only history is older than the upload window", async () => {
		await setReportingEnabled(directory, true)
		const old = new Date(Date.now() - 120 * 24 * 60 * 60_000).toISOString()
		const rows: WorkRecord[] = [
			{
				version: 1,
				type: "request",
				workId: "55555555-5555-4555-8555-555555555555",
				sessionId: "old-session",
				requestId,
				startedAt: old,
				recordedAt: old,
				scope: { account, repository: "/repo/.git" },
			},
		]
		const repositories = new Map([["/repo/.git", snapshot().content.repository]])
		const built = buildSnapshots(rows, calculatePullRequestCosts(rows, []), repositories)
		expect(built.snapshots.map((value) => value.content.requests)).toEqual([[]])
		expect((await queueSnapshots(directory, built.snapshots, true)).entries).toEqual({})
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
			const pending = Object.values((await readReportingState(directory)).entries).map((entry) =>
				JSON.stringify(entry.pending),
			)
			await setReportingEnabled(directory, false)
			await acknowledgeSnapshot(directory, key, "2", {
				status: "accepted",
				revision: "2",
				receivedAt: new Date().toISOString(),
			})
			expect(
				Object.values((await readReportingState(directory)).entries).map((entry) => JSON.stringify(entry.pending)),
			).toEqual(pending)
			await setReportingEnabled(directory, true)
		}
		// A restarted process sees only an independent repository; neither migration payload was acknowledged.
		const healthy = snapshot([otherRequestId])
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
	it("keeps a paused correction and ignores its late ACK after a same-membership replacement", async () => {
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
		const healthy = snapshot([otherRequestId])
		healthy.content.repository.id = "43"
		await queueSnapshots(directory, [oversized, healthy])
		const state = await readReportingState(directory)
		expect(Object.values(state.entries).map((entry) => entry.repository.id)).toEqual(["43"])
		expect(state.error).toContain("limits")
	})
	it("does not rewrite or sync an unchanged queue", async () => {
		await setReportingEnabled(directory, true)
		await queueSnapshots(directory, [snapshot([requestId])])
		const path = join(directory, "pr-cost-reporting", "state.json")
		const before = await files.stat(path)
		await queueSnapshots(directory, [snapshot([requestId])])
		const after = await files.stat(path)
		expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs])
	})
	it("holds only the replacement that would overflow the local queue", async () => {
		await setReportingEnabled(directory, true)
		// Four full repositories pass the 24 MiB queue; the others are queued, and the last one waits for room.
		const full = (repositoryId: string) => {
			const value = snapshot(Array.from({ length: SNAPSHOT_LIMITS.requests }, () => crypto.randomUUID()))
			value.content.repository.id = repositoryId
			return value
		}
		await queueSnapshots(directory, ["51", "52", "53", "54"].map(full))
		const state = await readReportingState(directory)
		expect(Object.values(state.entries).filter((entry) => entry.pending)).toHaveLength(3)
		expect(state.error).toContain("until queued reports leave room in the local queue")
		expect((await files.stat(join(directory, "pr-cost-reporting", "state.json"))).size).toBeLessThan(24 * 1024 * 1024)
	}, 60_000)
	it("reports an invalid replacement once, as invalid", async () => {
		await setReportingEnabled(directory, true)
		await queueSnapshots(directory, [snapshot([requestId])])
		const invalid = snapshot([requestId])
		invalid.content.requests[0].billingRecordIds = Array.from(
			{ length: 9 },
			(_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
		)
		await queueSnapshots(directory, [invalid])
		expect((await readReportingState(directory)).error).toBe(
			"PR reporting held 1 snapshot(s) that are invalid or exceed the upload limits after trimming",
		)
	})
	it("keeps the skipped request count of the latest capture until an explicit choice", async () => {
		await setReportingEnabled(directory, true)
		expect((await queueSnapshots(directory, [snapshot([requestId])], true, 3693)).skippedRequests).toBe(3693)
		expect((await queueSnapshots(directory, [snapshot([requestId])], true)).skippedRequests).toBeUndefined()
		await queueSnapshots(directory, [snapshot([requestId])], true, 2)
		expect((await setReportingEnabled(directory, false)).skippedRequests).toBeUndefined()
		const path = join(directory, "pr-cost-reporting", "state.json")
		await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")), skippedRequests: -1 }))
		await expect(readReportingState(directory)).rejects.toThrow("unreadable")
	})
	it("keeps the retry deadline when new source evidence replaces a rate-limited snapshot", async () => {
		await setReportingEnabled(directory, true)
		await queueSnapshots(directory, [snapshot([requestId])])
		const [key] = Object.keys((await readReportingState(directory)).entries)
		const retryAt = Date.now() + 120000
		await deferSnapshot(directory, key, "1", retryAt, "PR reporting returned HTTP 429")
		const changed = snapshot([requestId])
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
		await expect(queueSnapshots(directory, [snapshot([requestId])])).rejects.toThrow("disk unavailable")
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
		const healthy = snapshot([otherRequestId])
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
		await queueSnapshots(directory, [snapshot([requestId])])
		const before = await readReportingState(directory)
		const [key, first] = Object.entries(before.entries)[0]
		expect(first.pending?.revision).toBe("1")
		const next = snapshot([requestId])
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
	it("deduplicates concurrent captures and pauses pending payloads without resetting revisions", async () => {
		await setReportingEnabled(directory, true)
		await Promise.all([
			queueSnapshots(directory, [snapshot([requestId])]),
			queueSnapshots(directory, [snapshot([requestId])]),
		])
		const [key] = Object.keys((await readReportingState(directory)).entries)
		expect((await readReportingState(directory)).entries[key].revision).toBe("1")
		const pending = JSON.stringify((await readReportingState(directory)).entries[key].pending)
		await setReportingEnabled(directory, false)
		expect(JSON.stringify((await readReportingState(directory)).entries[key].pending)).toBe(pending)
		await setReportingEnabled(directory, true)
		await queueSnapshots(directory, [snapshot([requestId])])
		expect(JSON.stringify((await readReportingState(directory)).entries[key].pending)).toBe(pending)
	})
	it("separates accounts and advances beyond a server revision without acknowledging newer content", async () => {
		await setReportingEnabled(directory, true)
		const other = snapshot([requestId])
		other.account = { ...account, userId: "33333333-3333-4333-8333-333333333333" }
		await queueSnapshots(directory, [snapshot([requestId]), other])
		const [key] = Object.keys((await readReportingState(directory)).entries)
		await acknowledgeSnapshot(directory, key, "1", {
			status: "stale",
			revision: "8",
			receivedAt: new Date().toISOString(),
		})
		await queueSnapshots(directory, [snapshot([requestId]), other])
		const state = await readReportingState(directory)
		expect(Object.keys(state.entries)).toHaveLength(2)
		expect(state.entries[key].pending?.revision).toBe("9")
	})
})

describe("producer identity across machines", () => {
	const original = "a".repeat(64)
	const copy = "b".repeat(64)
	async function savedOn(machine: string | undefined) {
		vi.mocked(machineFingerprint).mockResolvedValue(machine)
		await setReportingEnabled(directory, true)
		const saved = await queueSnapshots(directory, [snapshot([requestId])])
		expect(saved.machine).toBe(machine)
		return saved
	}

	it("preserves copied legacy pending bytes and refuses new snapshots under the old producer", async () => {
		const saved = await savedOn(original)
		const path = join(directory, "pr-cost-reporting/state.json")
		const bytes = await readFile(path)
		vi.mocked(machineFingerprint).mockResolvedValue(copy)
		const next = await reportingProducer(directory, () => {})
		expect(next).not.toBe(saved.producerId)
		expect(await reportingProducer(directory, () => {})).toBe(next)
		const copied = await readReportingState(directory)
		expect(copied).toEqual(saved)
		expect(await readFile(path)).toEqual(bytes)
		await expect(queueSnapshots(directory, [snapshot([otherRequestId])])).rejects.toThrow("another machine")
		expect(await readFile(path)).toEqual(bytes)
		expect(await readReportingState(directory)).toEqual(saved)
	})

	it("creates one persisted producer for concurrent callers without a legacy queue", async () => {
		const producers = await Promise.all(Array.from({ length: 3 }, () => reportingProducer(directory, () => {})))
		expect(new Set(producers).size).toBe(1)
		expect(await reportingProducer(directory, () => {})).toBe(producers[0])
		expect(JSON.parse(backendFor(directory).getNote("agent", "reporting-producer") ?? "{}")).toEqual({
			version: 1,
			producerId: producers[0],
		})
		expect(backendFor(directory).recordCount()).toBe(0)
	})

	it("keeps legacy and frozen delta bytes across real SQLite producer initialization and process reopen", {
		timeout: 30_000,
	}, async () => {
		const saved = await savedOn(original)
		const path = join(directory, "pr-cost-reporting/state.json")
		const bytes = await readFile(path)
		const driver = fileURLToPath(new URL("../../../tests/e2e/tui/support/ledger-driver.ts", import.meta.url))
		const run = async () =>
			JSON.parse((await promisify(execFile)("bun", [driver, "producer", directory], { timeout: 30_000 })).stdout)
		const [first, concurrent] = await Promise.all([run(), run()])
		expect(concurrent.producerId).toBe(first.producerId)
		for (const result of [first, concurrent, await run()]) {
			expect(result).toMatchObject({
				producerId: first.producerId,
				legacyRetained: true,
				batchRetained: true,
				frozenProducer: saved.producerId,
				note: { version: 1, producerId: first.producerId },
			})
			expect(result.producerId !== saved.producerId).toBe(result.machineKnown)
		}
		expect(await readFile(path)).toEqual(bytes)
	})

	it("seeds the same-machine legacy producer once and ignores later old-writer state", async () => {
		const saved = await savedOn(original)
		const path = join(directory, "pr-cost-reporting/state.json")
		const bytes = await readFile(path)
		expect(await reportingProducer(directory, () => {})).toBe(saved.producerId)
		expect(await readFile(path)).toEqual(bytes)
		await writeFile(path, "unreadable old writer state")
		expect(await reportingProducer(directory, () => {})).toBe(saved.producerId)
		expect(await readFile(path, "utf8")).toBe("unreadable old writer state")
	})

	it("fills an initially unknown machine and retains identity while hardware is unavailable", async () => {
		const saved = await savedOn(undefined)
		expect(await reportingProducer(directory, () => {})).toBe(saved.producerId)
		vi.mocked(machineFingerprint).mockResolvedValue(original)
		expect(await reportingProducer(directory, () => {})).toBe(saved.producerId)
		const note = backendFor(directory).getNote("agent", "reporting-producer")
		expect(JSON.parse(note ?? "{}").machine).toBe(original)
		vi.mocked(machineFingerprint).mockResolvedValue(undefined)
		expect(await reportingProducer(directory, () => {})).toBe(saved.producerId)
		expect(backendFor(directory).getNote("agent", "reporting-producer")).toBe(note)
	})

	it("rolls back producer initialization when its lease is lost after the actual note write", async () => {
		const saved = await savedOn(original)
		const path = join(directory, "pr-cost-reporting/state.json")
		const bytes = await readFile(path)
		const backend = backendFor(directory)
		const putNote = backend.putNote.bind(backend)
		let written = false
		const write = vi.spyOn(backend, "putNote").mockImplementation((...args) => {
			putNote(...args)
			written = true
		})
		await expect(
			reportingProducer(directory, () => {
				if (written) throw new Error("lease lost")
			}),
		).rejects.toThrow("lease lost")
		expect(written).toBe(true)
		expect(backend.getNote("agent", "reporting-producer")).toBeUndefined()
		expect(await readFile(path)).toEqual(bytes)
		write.mockRestore()
		expect(await reportingProducer(directory, () => {})).toBe(saved.producerId)
	})

	it.each([
		"not JSON",
		"{}",
		JSON.stringify({ version: 2, producerId: requestId }),
		JSON.stringify({ version: 1, producerId: "invalid" }),
		JSON.stringify({ version: 1, producerId: requestId, machine: false }),
		JSON.stringify({ version: 1, producerId: requestId, machine: "invalid" }),
	])("retains an invalid existing producer note instead of reseeding from legacy state (%s)", async (body) => {
		await savedOn(original)
		const backend = backendFor(directory)
		backend.putNote("agent", "reporting-producer", body)
		await expect(reportingProducer(directory, () => {})).rejects.toThrow()
		expect(backend.getNote("agent", "reporting-producer")).toBe(body)
	})

	it("does not initialize over unreadable legacy state", async () => {
		await savedOn(original)
		const path = join(directory, "pr-cost-reporting/state.json")
		await writeFile(path, "unreadable legacy state")
		await expect(reportingProducer(directory, () => {})).rejects.toThrow("unreadable")
		expect(backendFor(directory).getNote("agent", "reporting-producer")).toBeUndefined()
		expect(await readFile(path, "utf8")).toBe("unreadable legacy state")
	})

	it("keeps the producer on the same machine and records the machine for older state", async () => {
		const legacy = await savedOn(undefined)
		vi.mocked(machineFingerprint).mockResolvedValue(original)
		expect(await readReportingState(directory)).toEqual(legacy)
		const next = await queueSnapshots(directory, [snapshot([requestId, otherRequestId])])
		expect([next.producerId, next.machine]).toEqual([legacy.producerId, original])
		expect(Object.values(next.entries)[0].revision).toBe("2")
	})

	it("keeps the producer when the machine cannot be identified", async () => {
		const saved = await savedOn(original)
		vi.mocked(machineFingerprint).mockResolvedValue(undefined)
		expect(await readReportingState(directory)).toEqual(saved)
	})
})

it("retains legacy bytes, ACK ownership and bounded scan progress in real SQLite", { timeout: 60_000 }, async () => {
	await setReportingEnabled(directory, true)
	await queueSnapshots(directory, [snapshot([requestId])])
	const driver = fileURLToPath(new URL("../../../tests/e2e/tui/support/ledger-driver.ts", import.meta.url))
	const result = JSON.parse(
		(await promisify(execFile)("bun", [driver, "legacy-freeze", directory], { timeout: 60_000 })).stdout,
	)
	expect(result).toEqual({
		initialBytes: true,
		ackRollback: true,
		receiptCorruptionRejected: true,
		cleanupReplay: true,
		partialScanProgress: true,
		retainedReceipts: 20,
		archivedOriginalBytes: true,
		pendingAfterArchive: 1,
		latestRetained: true,
		receiptScan: false,
		resumeScans: 0,
		reopened: true,
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

describe("snapshot size health", () => {
	it("reports the largest snapshot queued in a pass", async () => {
		await setReportingEnabled(directory, true)
		const metric = vi.spyOn(health, "trackPRCostMetric").mockImplementation(() => {})
		const other = snapshot([requestId, otherRequestId, billing])
		other.content.repository = { ...other.content.repository, id: "43" }
		const state = await queueSnapshots(directory, [snapshot([requestId]), other])
		const bytes = Math.max(
			...Object.values(state.entries).map((entry) => Buffer.byteLength(JSON.stringify(entry.pending))),
		)
		expect(metric).toHaveBeenCalledWith({ kind: "snapshotRequests", value: 3 })
		expect(metric).toHaveBeenCalledWith({ kind: "snapshotBytes", value: bytes })
		metric.mockClear()
		await queueSnapshots(directory, [snapshot([requestId]), other])
		expect(metric.mock.calls.filter(([value]) => value.kind.startsWith("snapshot"))).toEqual([])
	})
})

describe("upload window", () => {
	const key = `${accountKey(account)}:${repositoryKey(snapshot().content.repository)}`
	const at = "2026-10-04T12:00:00.000Z"
	const pull = (state: "open" | "merged" | "closed", requestIds = [requestId]) => {
		const value = snapshot(requestIds)
		value.content.pullRequests = [
			{
				id: "101",
				number: 1,
				url: "https://github.com/example/repo/pull/1",
				state,
				...(state === "merged" ? { mergedAt: at } : {}),
				...(state === "closed" ? { closedAt: at } : {}),
			},
		]
		value.content.requests[0].allocation = { kind: "pull-request", pullRequestIds: ["101"], method: "native" }
		return value
	}
	const corrected = (source: "work-command" | "producer-confirmation", revision = 1) => {
		const value = snapshot([requestId])
		value.content.requests[0].correction = { id: otherRequestId, revision, recordedAt: at, source }
		return value
	}
	const queue = async (...values: RepositorySnapshot[]) => (await queueSnapshots(directory, values, true)).entries
	const accept = async (id = key) => {
		const entry = (await readReportingState(directory)).entries[id]
		await acknowledgeSnapshot(directory, id, entry.revision, {
			status: "accepted",
			revision: entry.revision,
			receivedAt: new Date().toISOString(),
		})
	}

	it("lets a PR opening, merge or close skip the window, but not ordinary changes", async () => {
		await setReportingEnabled(directory, true)
		expect((await queue(snapshot([requestId])))[key].urgent).toBeUndefined()
		await accept()
		expect((await queue(pull("open")))[key].urgent).toBe(true)
		await accept()
		expect((await readReportingState(directory)).entries[key].markers).toEqual(["pull-request:101:open"])
		expect((await queue(pull("open", [requestId, otherRequestId])))[key].urgent).toBeUndefined()
		// A merge stays urgent through later replacements until the server acknowledges it.
		expect((await queue(pull("merged", [requestId, otherRequestId])))[key].urgent).toBe(true)
		expect((await queue(pull("merged")))[key].urgent).toBe(true)
		await accept()
		expect((await queue(pull("merged", [requestId, otherRequestId])))[key].urgent).toBeUndefined()
		expect((await queue(pull("closed", [requestId, otherRequestId])))[key].urgent).toBe(true)
	})
	it("lets an explicit /work correction skip the window, but not a producer confirmation", async () => {
		await setReportingEnabled(directory, true)
		await queue(snapshot([requestId]))
		await accept()
		expect((await queue(corrected("producer-confirmation")))[key].urgent).toBeUndefined()
		expect((await queue(corrected("work-command")))[key].urgent).toBe(true)
		await accept()
		expect((await queue(corrected("work-command", 2)))[key].urgent).toBe(true)
	})
	it("sends a withdrawal and the receiving repository of a correction at once", async () => {
		await setReportingEnabled(directory, true)
		const other = snapshot([otherRequestId])
		other.content.repository = { ...other.content.repository, id: "43" }
		const otherKey = `${accountKey(account)}:${repositoryKey(other.content.repository)}`
		await queue(snapshot([requestId]), other)
		await accept()
		await accept(otherKey)
		// /work link moves the request to repository 43; repository 42 is withdrawn.
		const moved = snapshot([otherRequestId, requestId])
		moved.content.repository = other.content.repository
		moved.content.requests[1].correction = { id: billing, revision: 1, recordedAt: at, source: "work-command" }
		const entries = await queue(moved)
		expect([entries[key].pending?.requests, entries[key].urgent]).toEqual([[], true])
		expect(entries[otherKey].urgent).toBe(true)
	})
	it("does not send an acknowledged withdrawal again when history completeness changes", async () => {
		await setReportingEnabled(directory, true)
		const moved = snapshot([requestId])
		moved.content.repository = { ...moved.content.repository, id: "43" }
		await queue(snapshot([requestId]))
		await accept()
		await queue(moved)
		await accept()
		// A repository lookup that fails and later recovers flips the completeness of the captures in between.
		for (const complete of [false, true]) await queueSnapshots(directory, [moved], complete)
		const { entries } = await readReportingState(directory)
		expect([entries[key].revision, entries[key].requestHashes, entries[key].pending]).toEqual(["2", [], undefined])
	})
	it("sends other changed repositories of the account at once only when a correction first appears", async () => {
		await setReportingEnabled(directory, true)
		const other = (requestIds: string[]) => {
			const value = snapshot(requestIds)
			value.content.repository = { ...value.content.repository, id: "43" }
			return value
		}
		const otherKey = `${accountKey(account)}:${repositoryKey(other([]).content.repository)}`
		const third = "66666666-6666-4666-8666-666666666666"
		await queue(snapshot([requestId]), other([otherRequestId]))
		await accept()
		await accept(otherKey)
		const correction = corrected("work-command")
		expect((await queue(correction, other([otherRequestId, third])))[otherKey].urgent).toBe(true)
		await accept(otherKey)
		// The receipt is still unacknowledged, yet a later ordinary change elsewhere waits for its window.
		expect((await queue(correction, other([otherRequestId])))[otherKey].urgent).toBeUndefined()
	})
	it("restarts the window and the retry deadline after /pr-reporting on", async () => {
		await setReportingEnabled(directory, true)
		await queue(snapshot([requestId]))
		await deferSnapshot(directory, key, "1", Date.now() + 3_600_000, "PR reporting returned HTTP 404")
		expect((await readReportingState(directory)).entries[key]).toMatchObject({
			attempts: 1,
			uploadedAt: expect.any(Number),
		})
		const state = await setReportingEnabled(directory, true)
		expect(state.entries[key]).toMatchObject({ attempts: 0, retryAt: 0, pending: { revision: "1" } })
		expect(state.entries[key].uploadedAt).toBeUndefined()
	})
})

describe("server limits", () => {
	const key = `${accountKey(account)}:${repositoryKey(snapshot().content.repository)}`
	const requests = (count: number) =>
		Array.from({ length: count }, (_, index) => `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`)

	it("pauses every repository of the account for an organization limit and keeps the notice once per pause", async () => {
		await setReportingEnabled(directory, true)
		await queueSnapshots(directory, [snapshot([requestId])])
		const limit = { scope: "organization" as const, limit: "requests" as const, current: 50000, maximum: 50000, at: 1 }
		const first = await limitSnapshot(directory, key, "1", limit, 1000)
		expect(first.paused).toEqual({ [accountKey(account)]: { limit, retryAt: 1000 } })
		expect(first.entries[key]).toMatchObject({ retryAt: 0, attempts: 0 })
		expect(first.entries[key].limit).toBeUndefined()
		expect(dueLimitNotices(first)).toEqual({ repositories: [], pauses: [limit] })
		expect(await takeLimitNotices(directory)).toEqual({ repositories: [], pauses: [limit] })
		const again = await limitSnapshot(directory, key, "1", { ...limit, at: 2 }, 2000)
		expect(again.paused?.[accountKey(account)]).toMatchObject({ retryAt: 2000, noticeShown: true })
		expect(await takeLimitNotices(directory)).toEqual({ repositories: [], pauses: [] })
	})
	it("lifts a pause only when an upload that adds claims is accepted", async () => {
		await setReportingEnabled(directory, true)
		const other = snapshot([otherRequestId])
		other.content.repository = { ...other.content.repository, id: "43" }
		const otherKey = `${accountKey(account)}:${repositoryKey(other.content.repository)}`
		await queueSnapshots(directory, [snapshot([requestId]), other], true)
		await limitSnapshot(directory, key, "1", { scope: "contributor", at: 1 }, Date.now() + 3_600_000)
		// Repository 43 is withdrawn: an empty snapshot frees space but proves nothing about the limit.
		const withdrawn = snapshot([otherRequestId, requestId])
		await queueSnapshots(directory, [withdrawn], true)
		const ack = { status: "accepted" as const, receivedAt: new Date().toISOString() }
		const state = await acknowledgeSnapshot(directory, otherKey, "2", { ...ack, revision: "2" })
		expect(state.paused).toBeDefined()
		expect((await acknowledgeSnapshot(directory, key, "2", { ...ack, revision: "2" })).paused).toBeUndefined()
	})
	it("waits on its own counter for a producer limit and clears it once an upload is accepted", async () => {
		await setReportingEnabled(directory, true)
		await queueSnapshots(directory, [snapshot([requestId])])
		const limit = { scope: "producer" as const, limit: "repositories" as const, current: 101, maximum: 100, at: 1 }
		const state = await limitSnapshot(directory, key, "1", limit, 5000)
		expect(state.entries[key]).toMatchObject({ limit, attempts: 0, retryAt: 5000 })
		expect(state.entries[key].learned).toBeUndefined()
		expect(dueLimitNotices(state).repositories).toEqual([snapshot().content.repository])
		const accepted = await acknowledgeSnapshot(directory, key, "1", {
			status: "accepted",
			revision: "1",
			receivedAt: new Date().toISOString(),
		})
		expect(accepted.entries[key].limit).toBeUndefined()
	})
	it.each([
		// 6 sent, 12 counted: the server adds 6, so only 4 fit, not the proportional 5.
		["requests", 12, 10, 6, { requests: 4 }],
		["requests", undefined, undefined, 6, { requests: 5 }],
		["pullRequests", 3, 2, 3, undefined],
		["windowedPullRequests", 2001, 2000, 3, undefined],
	] as const)("learns a smaller %s limit from a snapshot rejection (%s of %s)", async (name, current, maximum, size, learned) => {
		await setReportingEnabled(directory, true)
		await queueSnapshots(directory, [snapshot(requests(size))])
		const at = Date.now()
		const limit = { scope: "snapshot" as const, limit: name, current, maximum, at }
		const state = await limitSnapshot(directory, key, "1", limit, at + 1000)
		expect(state.entries[key].limit).toEqual(limit)
		if (!learned) {
			// No PRs were sent, and windowed IDs never exceed the server's limit, so sending fewer cannot help.
			expect(state.entries[key].learned).toBeUndefined()
			return
		}
		expect(state.entries[key].learned).toEqual({ ...learned, until: at + 7 * 24 * 60 * 60_000 })
		expect(learnedLimits(state, at).get(key)).toEqual({ ...SNAPSHOT_LIMITS, ...learned })
		expect(learnedLimits(state, at + 7 * 24 * 60 * 60_000).size).toBe(0)
	})
	it("learns in one rejection a cap that fits when the server counts 26,000 retained requests besides the upload", async () => {
		await setReportingEnabled(directory, true)
		const retained = 26_000
		const upload = snapshot(requests(15_800))
		await queueSnapshots(directory, [upload])
		const at = Date.now()
		const current = upload.content.requests.length + retained
		const limit = { scope: "snapshot" as const, limit: "requests" as const, current, maximum: 32_000, at }
		const limits = learnedLimits(await limitSnapshot(directory, key, "1", limit, at + 1000), at).get(key)
		expect(limits).toEqual({ ...SNAPSHOT_LIMITS, requests: 6_000 })
		// The next upload is trimmed to the learned cap, and with the retained requests it fits the server's.
		const next = fitSnapshot(upload.content, limits ?? SNAPSHOT_LIMITS, () => true)
		expect((next?.content.requests.length ?? current) + retained).toBeLessThanOrEqual(32_000)
	})
	it("learns bytes from the server's measure, so a different encoding still converges", async () => {
		await setReportingEnabled(directory, true)
		await queueSnapshots(directory, [snapshot(requests(4))])
		const pending = (await readReportingState(directory)).entries[key].pending
		const bytes = Buffer.byteLength(JSON.stringify(pending))
		const state = await limitSnapshot(
			directory,
			key,
			"1",
			{ scope: "snapshot", limit: "bytes", current: bytes * 2, maximum: bytes, at: 1 },
			1000,
		)
		expect(state.entries[key].learned?.bytes).toBe(Math.floor(bytes / 2))
	})
	it("lets /pr-reporting on retry an account pause and a repository limit at once", async () => {
		await setReportingEnabled(directory, true)
		await queueSnapshots(directory, [snapshot([requestId])])
		await limitSnapshot(directory, key, "1", { scope: "producer", at: 1 }, Date.now() + 3_600_000)
		await limitSnapshot(directory, key, "1", { scope: "organization", at: 1 }, Date.now() + 3_600_000)
		const state = await setReportingEnabled(directory, true)
		expect(state.paused).toBeUndefined()
		expect(state.entries[key]).toMatchObject({ retryAt: 0, limit: { scope: "producer" } })
	})
	it("ignores a limit for a revision that was already replaced", async () => {
		await setReportingEnabled(directory, true)
		await queueSnapshots(directory, [snapshot([requestId])])
		await queueSnapshots(directory, [snapshot([requestId, otherRequestId])])
		const state = await limitSnapshot(directory, key, "1", { scope: "producer", at: 1 }, 1000)
		expect(state.entries[key].limit).toBeUndefined()
	})
	it("shows a repository's partial-report notice once across concurrent sessions", async () => {
		await setReportingEnabled(directory, true)
		const trimmed = snapshot([requestId])
		trimmed.content.coverage = { ...trimmed.content.coverage, historyComplete: false, trimmedRequests: 4 }
		const state = await queueSnapshots(directory, [trimmed])
		expect(state.entries[key].trimmed).toBe(4)
		const taken = await Promise.all([takeLimitNotices(directory), takeLimitNotices(directory)])
		expect(taken.flatMap((notices) => notices.repositories)).toEqual([trimmed.content.repository])
		expect((await queueSnapshots(directory, [snapshot([requestId, otherRequestId])])).entries[key]).toMatchObject({
			limitNoticeShown: true,
		})
		expect((await readReportingState(directory)).entries[key].trimmed).toBeUndefined()
	})
	it.each([
		["markers", "pull-request:101:open"],
		["uploadedAt", "yesterday"],
		["limit", { scope: "everywhere", at: 1 }],
		["learned", { requests: 0, until: 1 }],
		["urgent", false],
	])("fails closed on an invalid %s field", async (field, value) => {
		await setReportingEnabled(directory, true)
		await queueSnapshots(directory, [snapshot([requestId])])
		const path = join(directory, "pr-cost-reporting", "state.json")
		const saved = JSON.parse(await readFile(path, "utf8"))
		saved.entries[key][field] = value
		await writeFile(path, JSON.stringify(saved))
		await expect(readReportingState(directory)).rejects.toThrow("unreadable")
	})
	it("fails closed on an invalid account pause", async () => {
		await setReportingEnabled(directory, true)
		const path = join(directory, "pr-cost-reporting", "state.json")
		const saved = JSON.parse(await readFile(path, "utf8"))
		saved.paused = { [accountKey(account)]: { limit: { scope: "organization", at: 1 }, retryAt: "soon" } }
		await writeFile(path, JSON.stringify(saved))
		await expect(readReportingState(directory)).rejects.toThrow("unreadable")
	})
})
