import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { savePlanMarkdown } from "../../shared/planning/plan-markdown.js"
import { createContext } from "../__mocks__/context.js"
import { createWorkScopeSnapshot } from "../__mocks__/work-scope.js"
import * as attribution from "../work-attribution.js"
import { appendWorkRecord, getWorkId, recordProviderRequest } from "../work-attribution.js"
import type { WorkContinuation } from "./continuation.js"
import { calculatePullRequestCosts } from "./costs.js"
import { confirmWorkContinuation, correctWorkLink, pinWorkContinuation, reconcileWorkContinuations } from "./links.js"
import * as scope from "./scope.js"
import { flushWorkSummaries, readWorkRecords, type WorkRecord } from "./summary.js"

vi.mock("node:fs", async (original) => ({ ...(await original<typeof fs>()) }))

let dir: string
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kimchi-work-link-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", dir)
})
afterEach(async () => {
	await flushWorkSummaries()
	vi.useRealTimers()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	rmSync(dir, { recursive: true, force: true })
})

it.each([
	"account",
	"repository",
	"legacy",
	"revoked-permission",
])("refuses an explicit correction with %s scope instead of adopting today's account", async (kind) => {
	const captured = createWorkScopeSnapshot(join(dir, ".git"))
	vi.spyOn(scope, "captureWorkScope").mockResolvedValue({ ...captured, isCurrent: () => kind !== "revoked-permission" })
	const planner = createContext({ cwd: dir, sessionManager: { getSessionId: () => "planner" } })
	const sourceWorkId = getWorkId(planner)
	const originalScope = structuredClone(captured.scope)
	if (kind === "account") originalScope.account.organizationId = randomUUID()
	if (kind === "repository") originalScope.repository = join(dir, "other.git")
	if (kind !== "legacy") scope.saveNewWorkScope(sourceWorkId, originalScope)
	const segment = { id: randomUUID(), attribution: "session", reason: "matching-disabled" } as const
	recordProviderRequest({ ...planner, segment })
	const implementer = createContext({ cwd: dir, sessionManager: { getSessionId: () => "implementer" } })
	scope.saveNewWorkScope(getWorkId(implementer), captured.scope)
	recordProviderRequest(implementer)
	await expect(correctWorkLink(implementer, `link ${sourceWorkId} ${segment.id}`)).rejects.toThrow(/account|repository/)
	expect(readWorkRecords(dir).filter((row) => row.type === "work_link")).toEqual([])
})

it("refuses a correction when the session changes during account verification", async () => {
	const captured = createWorkScopeSnapshot(join(dir, ".git"))
	let session = "old-session"
	const ctx = createContext({ cwd: dir, sessionManager: { getSessionId: () => session } })
	scope.saveNewWorkScope(getWorkId(ctx), captured.scope)
	vi.spyOn(scope, "captureWorkScope").mockImplementation(async () => {
		session = "new-session"
		return captured
	})
	await expect(correctWorkLink(ctx, `link ${randomUUID()} ${randomUUID()}`)).rejects.toThrow(/account|repository/)
	expect(readWorkRecords(dir).filter((row) => row.type === "work_link")).toEqual([])
})

function acceptedContinuation(kind: "plan" | "artifact" = "plan", name = "planner") {
	const ctx = createContext({ cwd: dir, sessionManager: { getSessionId: () => name } })
	const workId = getWorkId(ctx)
	const originalScope = createWorkScopeSnapshot(join(dir, ".git")).scope
	scope.saveNewWorkScope(workId, originalScope)
	const segment = { id: randomUUID(), attribution: "unknown", reason: "unresolved-reference" } as const
	const unrelated = recordProviderRequest({ ...ctx, segment: { ...segment, id: randomUUID() } }).requestId
	const research = recordProviderRequest({ ...ctx, segment }).requestId
	const producer = recordProviderRequest({ ...ctx, segment }).requestId
	const saved = savePlanMarkdown({ cwd: dir, name, planText: "# Implement export\n", workId })
	if (!saved.snapshotPath || !saved.contentHash) throw new Error("Missing retained plan")
	const transitionId = randomUUID()
	const origin =
		kind === "plan"
			? { type: "plan", ...saved, requestId: producer }
			: {
					type: "file_transition",
					transitionId,
					toolCallId: "write",
					repository: originalScope.repository,
					worktree: dir,
					path: "docs/adr.md",
					requestId: producer,
				}
	appendWorkRecord(ctx, origin, workId)
	const continuation: Pick<WorkContinuation, "source" | "evidence"> = {
		source: kind === "plan" ? "saved-plan" : "named-artifact",
		evidence: {
			path: saved.snapshotPath,
			...originalScope,
			segmentId: randomUUID(),
			requestId: producer,
			...(kind === "plan" ? { contentHash: saved.contentHash } : { transitionId }),
		},
	}
	const consumer = createContext({ cwd: dir, sessionManager: { getSessionId: () => `${name}-consumer` } })
	appendWorkRecord(consumer, { type: "work", continuation }, workId)
	return { ctx, consumer, workId, originalScope, segment, unrelated, research, producer, saved, origin, continuation }
}
function repair(progress: { nextContinuation?: string } = {}, assertLease = () => {}) {
	return reconcileWorkContinuations(dir, new AbortController().signal, assertLease, progress)
}
function links(): WorkRecord[] {
	return readWorkRecords(dir).filter((row) => row.type === "work_link")
}

it.each([
	"plan",
	"artifact",
] as const)("repairs an accepted %s after restart without changing requests or prices", async (kind) => {
	const flow = acceptedContinuation(kind)
	const original = readWorkRecords(dir).filter((row) => row.type === "request")
	appendWorkRecord(
		flow.ctx,
		{
			type: "commit",
			sha: "a".repeat(40),
			repository: flow.originalScope.repository,
			worktree: dir,
			pullRequests: [
				{
					provider: "github",
					host: "github.com",
					repository: "example/repo",
					number: 1,
					url: "https://github.com/example/repo/pull/1",
					state: "merged",
					headSha: "a".repeat(40),
					mergeCommitSha: "b".repeat(40),
					mergedAt: "2030-01-01T00:00:00Z",
					closedAt: null,
					checkedAt: "2030-01-01T00:00:00Z",
				},
			],
		},
		flow.workId,
	)
	const prices = [flow.unrelated, flow.research, flow.producer].map((requestId) => ({
		requestId,
		billingRecordId: requestId,
		costUsd: "0.125",
		account: flow.originalScope.account,
	}))
	const before = calculatePullRequestCosts(readWorkRecords(dir), prices)
	const account = vi.spyOn(scope, "captureWorkScope").mockRejectedValue(new Error("Must not read today's account"))
	const currentWork = vi.spyOn(attribution, "getWorkId")
	await repair()
	await repair()
	expect(account).not.toHaveBeenCalled()
	expect(currentWork).not.toHaveBeenCalled()
	expect(links()).toMatchObject([
		{
			sessionId: flow.consumer.sessionManager.getSessionId(),
			workId: flow.workId,
			sourceWorkId: flow.workId,
			targetWorkId: flow.workId,
			scope: flow.originalScope,
			requestIds: [flow.research, flow.producer].sort(),
			evidence: { segmentId: flow.segment.id },
		},
	])
	expect(readWorkRecords(dir).filter((row) => row.type === "request")).toEqual(original)
	const after = calculatePullRequestCosts(readWorkRecords(dir), prices)
	expect(after.requests.map(({ requestId, totalCostUsd }) => ({ requestId, totalCostUsd }))).toEqual(
		before.requests.map(({ requestId, totalCostUsd }) => ({ requestId, totalCostUsd })),
	)
	expect(after.pullRequests[0].knownCostUsd).toBe("0.250000000")
	expect(after.requests.find((row) => row.requestId === flow.unrelated)?.allocation).toBe("unknown")
})

it("retries an accepted continuation when its original producer record is restored", async () => {
	const flow = acceptedContinuation()
	const ledger = join(dir, "work-attribution", `${flow.ctx.sessionManager.getSessionId()}.jsonl`)
	const original = readWorkRecords(dir).find((row) => row.type === "plan")
	const rows = readWorkRecords(dir).filter(
		(row) => row.sessionId === flow.ctx.sessionManager.getSessionId() && row.type !== "plan",
	)
	fs.writeFileSync(ledger, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)
	await repair()
	expect(links()).toEqual([])
	fs.appendFileSync(ledger, `${JSON.stringify(original)}\n`)
	await repair()
	expect(links()).toHaveLength(1)
})

it("can use restored pre-acceptance production when no producer identity was available at acceptance", async () => {
	vi.useFakeTimers({ toFake: ["Date"] })
	vi.setSystemTime(new Date("2026-10-05T09:00:00Z"))
	const flow = acceptedContinuation()
	const records = readWorkRecords(dir)
	const original = records.find((row) => row.type === "plan")
	const ledger = join(dir, "work-attribution", `${flow.ctx.sessionManager.getSessionId()}.jsonl`)
	fs.writeFileSync(
		ledger,
		`${records
			.filter((row) => row.sessionId === flow.ctx.sessionManager.getSessionId() && row.type !== "plan")
			.map((row) => JSON.stringify(row))
			.join("\n")}\n`,
	)
	vi.setSystemTime(new Date("2026-10-05T09:01:00Z"))
	const { requestId: _requestId, ...evidence } = flow.continuation.evidence
	fs.writeFileSync(
		join(dir, "work-attribution", `${flow.consumer.sessionManager.getSessionId()}.jsonl`),
		`${JSON.stringify({ version: 1, type: "work", workId: flow.workId, cwd: dir, recordedAt: new Date().toISOString(), sessionId: flow.consumer.sessionManager.getSessionId(), continuation: { ...flow.continuation, evidence } })}\n`,
	)
	await repair()
	expect(links()).toEqual([])
	fs.appendFileSync(ledger, `${JSON.stringify(original)}\n`)
	await repair()
	expect(links()).toHaveLength(1)
})

it("uses accepted plan bytes after the editable path changes, without confirming its new producer", async () => {
	const flow = acceptedContinuation()
	appendWorkRecord(
		flow.consumer,
		{
			type: "work",
			continuation: { ...flow.continuation, evidence: { ...flow.continuation.evidence, path: flow.saved.path } },
		},
		flow.workId,
	)
	const later = recordProviderRequest({ ...flow.ctx, segment: { ...flow.segment, id: randomUUID() } })
	const replacement = savePlanMarkdown({ cwd: dir, name: "planner", planText: "# A later task\n", workId: flow.workId })
	appendWorkRecord(flow.ctx, { type: "plan", ...replacement, requestId: later.requestId }, flow.workId)
	await repair()
	expect(links()).toHaveLength(1)
	expect(links()[0].requestIds).toEqual([flow.research, flow.producer].sort())
})

it.each([
	"legacy-plan",
	"edited-restored",
	"semantic",
	"scope-missing",
	"receipt-account",
	"receipt-repository",
	"request-account",
	"request-unscoped",
	"ambiguous-producer",
	"missing-segment",
	"inferred-segment",
])("leaves %s history unknown", async (kind) => {
	const flow = acceptedContinuation()
	const receipt = structuredClone(flow.continuation)
	if (kind === "legacy-plan") receipt.evidence.contentHash = undefined
	if (kind === "edited-restored")
		receipt.evidence.contentHash = createHash("sha256").update("different accepted bytes").digest("hex")
	if (kind === "semantic") receipt.source = "semantic"
	if (kind === "receipt-account")
		receipt.evidence.account = { ...flow.originalScope.account, organizationId: randomUUID() }
	if (kind === "receipt-repository") receipt.evidence.repository = join(dir, "other.git")
	fs.writeFileSync(
		join(dir, "work-attribution", `${flow.consumer.sessionManager.getSessionId()}.jsonl`),
		`${JSON.stringify({ version: 1, type: "work", workId: flow.workId, cwd: dir, recordedAt: new Date().toISOString(), sessionId: flow.consumer.sessionManager.getSessionId(), continuation: receipt })}\n`,
	)
	if (kind === "scope-missing") fs.rmSync(join(dir, "work", flow.workId, "scope.json"))
	const request = readWorkRecords(dir).find((row) => row.type === "request" && row.requestId === flow.producer)
	if (!request) throw new Error("Missing producer")
	if (kind === "request-account")
		appendWorkRecord(
			flow.ctx,
			{
				...request,
				scope: { ...flow.originalScope, account: { ...flow.originalScope.account, userId: randomUUID() } },
			},
			flow.workId,
		)
	if (kind === "request-unscoped") appendWorkRecord(flow.ctx, { ...request, scope: null }, flow.workId)
	if (kind === "missing-segment") appendWorkRecord(flow.ctx, { ...request, segment: undefined }, flow.workId)
	if (kind === "inferred-segment")
		appendWorkRecord(flow.ctx, { ...request, segment: { ...flow.segment, attribution: "inferred" } }, flow.workId)
	if (kind === "ambiguous-producer")
		appendWorkRecord(flow.ctx, { ...flow.origin, requestId: flow.unrelated }, flow.workId)
	await repair()
	expect(links()).toEqual([])
})

it("repairs a legacy native transition receipt using only its original scope", async () => {
	const flow = acceptedContinuation("artifact")
	const { account: _account, segmentId: _segmentId, requestId: _requestId, ...evidence } = flow.continuation.evidence
	fs.writeFileSync(
		join(dir, "work-attribution", `${flow.consumer.sessionManager.getSessionId()}.jsonl`),
		`${JSON.stringify({ version: 1, type: "work", workId: flow.workId, cwd: dir, sessionId: flow.consumer.sessionManager.getSessionId(), continuation: { source: "named-artifact", evidence } })}\n`,
	)
	await repair()
	expect(links()).toHaveLength(1)
})

it.each(["active", "revoked"])("never replaces an existing %s correction", async (status) => {
	const flow = acceptedContinuation()
	appendWorkRecord(
		flow.ctx,
		{
			type: "work_link",
			linkId: randomUUID(),
			revision: 1,
			status,
			sourceWorkId: flow.workId,
			targetWorkId: flow.workId,
			requestIds: [flow.research],
			scope: flow.originalScope,
			evidence: { source: "work-command", segmentId: flow.segment.id },
		},
		flow.workId,
	)
	await repair()
	expect(links()).toHaveLength(1)
	expect(links()[0].status).toBe(status)
})

it("does not use a partial ledger scan and retries the complete scan later", async () => {
	acceptedContinuation()
	await flushWorkSummaries()
	const read = fs.readFileSync
	const failure = vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
		if (String(args[0]).endsWith("planner.jsonl")) throw Object.assign(new Error("Denied"), { code: "EACCES" })
		return read(...args)
	})
	await expect(repair()).rejects.toThrow("Could not read work ledger")
	failure.mockRestore()
	expect(links()).toEqual([])
	await repair()
	expect(links()).toHaveLength(1)
})

for (const mode of ["pin", "live", "history"] as const) {
	it.each([
		"truncated-correction",
		"invalid-correction",
		"invalid-producer",
	])(`${mode} refuses a source snapshot containing %s and retries after repair`, async (kind) => {
		const flow = acceptedContinuation()
		await flushWorkSummaries()
		const requests = readWorkRecords(dir).filter((row) => row.type === "request")
		const correction = {
			version: 1,
			type: "work_link",
			workId: flow.workId,
			sessionId: "correction",
			linkId: randomUUID(),
			revision: 2,
			status: "revoked",
			sourceWorkId: flow.workId,
			targetWorkId: flow.workId,
			requestIds: [flow.producer],
			scope: flow.originalScope,
			evidence: { source: "work-command", segmentId: flow.segment.id },
		}
		const line =
			kind === "truncated-correction"
				? JSON.stringify(correction).slice(0, -1)
				: JSON.stringify(
						kind === "invalid-correction"
							? { ...correction, targetWorkId: null }
							: {
									version: 1,
									workId: flow.workId,
									sessionId: "second-producer",
									...flow.origin,
									path: null,
									requestId: flow.unrelated,
								},
					)
		const damaged = join(dir, "work-attribution", "damaged.jsonl")
		fs.writeFileSync(damaged, `${line}\n`)
		const continuation = { ...flow.continuation, workId: flow.workId }
		const invoke = () =>
			mode === "pin"
				? pinWorkContinuation(continuation)
				: mode === "live"
					? confirmWorkContinuation(flow.ctx, continuation, flow.originalScope)
					: repair()
		await expect(Promise.resolve().then(invoke)).rejects.toThrow("Incomplete work history")
		expect(links()).toEqual([])
		// Repairing the source, including an empty journal, permits a fresh complete scan.
		fs.writeFileSync(damaged, "\n \t\r\n")
		const recovered = await invoke()
		if (mode === "pin") expect(recovered).toMatchObject({ evidence: { requestId: flow.producer } })
		else expect(links()).toHaveLength(1)
		expect(readWorkRecords(dir).filter((row) => row.type === "request")).toEqual(requests)
		const report = calculatePullRequestCosts(readWorkRecords(dir), [
			{
				requestId: flow.producer,
				billingRecordId: flow.producer,
				costUsd: "0.125",
				account: flow.originalScope.account,
			},
		])
		expect(report.requests.find((row) => row.requestId === flow.producer)?.totalCostUsd).toBe("0.125000000")
	})

	it.each([
		"present",
		"missing",
		"changed",
	])(`${mode} keeps both matching producers unresolved when one retained plan is %s`, async (kind) => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(new Date("2026-10-05T09:00:00Z"))
		const flow = acceptedContinuation()
		await flushWorkSummaries()
		const snapshotPath = join(dir, "other-retained.md")
		if (kind !== "missing")
			fs.writeFileSync(snapshotPath, kind === "present" ? fs.readFileSync(flow.continuation.evidence.path) : "changed")
		appendWorkRecord(flow.ctx, { ...flow.origin, snapshotPath, requestId: flow.unrelated }, flow.workId)
		const { requestId: _requestId, ...evidence } = flow.continuation.evidence
		const continuation: WorkContinuation = {
			...flow.continuation,
			workId: flow.workId,
			evidence: { ...evidence, path: flow.saved.path },
		}
		vi.setSystemTime(new Date("2026-10-05T09:01:00Z"))
		fs.writeFileSync(
			join(dir, "work-attribution", `${flow.consumer.sessionManager.getSessionId()}.jsonl`),
			`${JSON.stringify({ version: 1, type: "work", workId: flow.workId, cwd: dir, recordedAt: new Date().toISOString(), sessionId: flow.consumer.sessionManager.getSessionId(), continuation })}\n`,
		)
		const producers = readWorkRecords(dir).filter(
			(row) =>
				row.type === "plan" && row.path === continuation.evidence.path && row.contentHash === evidence.contentHash,
		)
		expect(new Set(producers.map((row) => row.requestId)).size).toBe(2)
		if (mode === "pin") expect(pinWorkContinuation(continuation).evidence.requestId).toBeUndefined()
		else if (mode === "live") confirmWorkContinuation(flow.ctx, continuation, flow.originalScope)
		else await repair()
		expect(links()).toEqual([])
	})
}

it("retries a failed append without recording history as complete", async () => {
	acceptedContinuation()
	await flushWorkSummaries()
	const write = fs.writeFileSync
	const failure = vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
		if (String(args[1]).includes('"type":"work_link"')) throw new Error("Disk full")
		return write(...args)
	})
	await expect(repair()).rejects.toThrow("Disk full")
	failure.mockRestore()
	expect(links()).toEqual([])
	await repair()
	expect(links()).toHaveLength(1)
})

it("stops before publishing when the lease is lost", async () => {
	acceptedContinuation()
	await expect(
		repair({}, () => {
			throw new Error("Lease lost")
		}),
	).rejects.toThrow("Lease lost")
	expect(links()).toEqual([])
})

it.each(["later request", "earlier request"])("never uses a later same-hash plan produced by a %s", async (kind) => {
	vi.useFakeTimers({ toFake: ["Date"] })
	vi.setSystemTime(new Date("2026-10-05T09:00:00Z"))
	const flow = acceptedContinuation()
	const { requestId: _requestId, ...evidence } = flow.continuation.evidence
	fs.writeFileSync(
		join(dir, "work-attribution", `${flow.consumer.sessionManager.getSessionId()}.jsonl`),
		`${JSON.stringify({ version: 1, type: "work", workId: flow.workId, cwd: dir, recordedAt: new Date().toISOString(), sessionId: flow.consumer.sessionManager.getSessionId(), continuation: { ...flow.continuation, evidence } })}\n`,
	)
	const ledger = join(dir, "work-attribution", `${flow.ctx.sessionManager.getSessionId()}.jsonl`)
	const rows = readWorkRecords(dir).filter(
		(row) => row.sessionId === flow.ctx.sessionManager.getSessionId() && row.type !== "plan",
	)
	fs.writeFileSync(ledger, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)
	vi.setSystemTime(new Date("2026-10-05T09:01:00Z"))
	const requestId =
		kind === "earlier request"
			? flow.unrelated
			: recordProviderRequest({ ...flow.ctx, segment: { ...flow.segment, id: randomUUID() } }).requestId
	appendWorkRecord(flow.ctx, { ...flow.origin, requestId }, flow.workId)
	await repair()
	expect(links()).toEqual([])
})

it("abandons an over-budget source scan before writing and retries it later", async () => {
	acceptedContinuation()
	await flushWorkSummaries()
	let now = 0
	vi.spyOn(Date, "now").mockImplementation(() => now)
	const read = fs.readFileSync
	const slow = vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
		if (String(args[0]).endsWith(".jsonl")) now += 4000
		return read(...args)
	})
	await expect(repair()).rejects.toThrow("Could not read work ledger")
	slow.mockRestore()
	expect(links()).toEqual([])
	await repair()
	expect(links()).toHaveLength(1)
})

it("moves a slow receipt behind its sibling on the next bounded pass", async () => {
	acceptedContinuation("plan", "first")
	acceptedContinuation("plan", "second")
	await flushWorkSummaries()
	let now = 0
	let slowPath: string | undefined
	vi.spyOn(Date, "now").mockImplementation(() => now)
	const read = fs.readFileSync
	const slow = vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
		const path = String(args[0])
		if (path.endsWith(".md")) {
			slowPath ??= path
			if (path === slowPath) now += 4000
		}
		return read(...args)
	})
	const progress = {}
	await expect(repair(progress)).rejects.toThrow("time limit")
	expect(links()).toHaveLength(0)
	await expect(repair(progress)).rejects.toThrow("time limit")
	expect(links()).toHaveLength(1)
	slow.mockRestore()
	await repair(progress)
	expect(links()).toHaveLength(2)
})

it("recovers a large receipt set over bounded passes without permanently skipping a receipt", async () => {
	for (let index = 0; index < 26; index++) acceptedContinuation("plan", `planner-${index}`)
	const progress = {}
	await repair(progress)
	expect(links()).toHaveLength(25)
	await repair(progress)
	expect(links()).toHaveLength(26)
	await repair(progress)
	expect(links()).toHaveLength(26)
})

it("keeps a concurrent revocation authoritative when its append follows the repair snapshot", async () => {
	const flow = acceptedContinuation()
	await flushWorkSummaries()
	const read = fs.readFileSync
	let revoked = false
	const linkId = randomUUID()
	const correction = {
		type: "work_link",
		linkId,
		sourceWorkId: flow.workId,
		targetWorkId: flow.workId,
		requestIds: [flow.research, flow.producer].sort(),
		scope: flow.originalScope,
		evidence: { source: "work-command", segmentId: flow.segment.id },
	}
	vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
		const value = read(...args)
		if (!revoked && args[0] === flow.saved.snapshotPath) {
			revoked = true
			// A different harness process can append while this process reads the retained file.
			appendWorkRecord(flow.ctx, { ...correction, revision: 1, status: "active" }, flow.workId)
			appendWorkRecord(flow.ctx, { ...correction, revision: 2, status: "revoked" }, flow.workId)
		}
		return value
	})
	await repair()
	expect(revoked).toBe(true)
	expect(links().filter((row) => row.linkId === linkId)).toMatchObject([
		{ revision: 1, status: "active" },
		{ revision: 2, status: "revoked" },
	])
	const report = calculatePullRequestCosts(readWorkRecords(dir), [
		{
			requestId: flow.producer,
			billingRecordId: flow.producer,
			costUsd: "0.125",
			account: flow.originalScope.account,
		},
	])
	expect(report.requests.find((row) => row.requestId === flow.producer)).toMatchObject({
		allocation: "unknown",
		reason: "work-link-unresolved",
		totalCostUsd: "0.125000000",
	})
})
