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
import {
	confirmWorkContinuation,
	correctWorkLink,
	pinWorkContinuation,
	reconcileWorkContinuations,
	requestWorkLinks,
} from "./links.js"
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

it.each(["session", "inferred"] as const)("confirms the %s input that produced a continued plan", (attribution) => {
	const ctx = createContext({ cwd: dir })
	const workId = getWorkId(ctx)
	const originalScope = createWorkScopeSnapshot(join(dir, ".git")).scope
	scope.saveNewWorkScope(workId, originalScope)
	const segment = { id: randomUUID(), attribution, reason: "planning" }
	const unrelated = recordProviderRequest({ ...ctx, segment: { ...segment, id: randomUUID() } })
	const research = recordProviderRequest({ ...ctx, segment })
	const producer = recordProviderRequest({ ...ctx, segment })
	const plan = savePlanMarkdown({ cwd: dir, name: "export", planText: "# Export\n", workId })
	appendWorkRecord(ctx, { type: "plan", ...plan, requestId: producer.requestId })
	confirmWorkContinuation(
		ctx,
		{ workId, source: "saved-plan", evidence: { path: plan.path, contentHash: plan.contentHash } },
		originalScope,
	)
	const links = requestWorkLinks(readWorkRecords(dir))
	for (const request of [research, producer]) {
		expect(links.get(request.requestId)).toMatchObject({ workIds: new Set([workId]), unresolved: false })
	}
	expect(links.has(unrelated.requestId)).toBe(false)
})

it.each([
	["accepts", null],
	["rejects", "88888888-8888-4888-8888-888888888888"],
] as const)("%s a link into a work whose other request has %s scope", (outcome, organizationId) => {
	const source = "11111111-1111-4111-8111-111111111111"
	const target = "22222222-2222-4222-8222-222222222222"
	const workScope = createWorkScopeSnapshot(join(dir, ".git")).scope
	const request = (requestId: string, workId: string, scope: unknown = workScope) =>
		({ version: 1, type: "request", workId, sessionId: workId, requestId, scope }) as WorkRecord
	const moved = randomUUID()
	const links = requestWorkLinks([
		request(moved, source),
		// A new work's first input stays unscoped when its account check was unavailable.
		request(
			randomUUID(),
			target,
			organizationId && { ...workScope, account: { ...workScope.account, organizationId } },
		),
		request(randomUUID(), target),
		{
			version: 1,
			type: "work_link",
			workId: target,
			sessionId: target,
			linkId: randomUUID(),
			revision: 1,
			sourceWorkId: source,
			targetWorkId: target,
			requestIds: [moved],
			scope: workScope,
			status: "active",
			evidence: { source: "work-command" },
		} as WorkRecord,
	])
	expect(links.get(moved)).toMatchObject({ workIds: new Set([target]), unresolved: outcome === "rejects" })
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

it("replaces a revoked automatic confirmation when its input is linked to another work", async () => {
	const originalScope = createWorkScopeSnapshot(join(dir, ".git")).scope
	vi.spyOn(scope, "captureWorkScope").mockResolvedValue({ scope: originalScope, isCurrent: () => true })
	const planner = createContext({ cwd: dir, sessionManager: { getSessionId: () => "planner" } })
	const workId = getWorkId(planner)
	scope.saveNewWorkScope(workId, originalScope)
	const segment = { id: randomUUID(), attribution: "unknown", reason: "planning" } as const
	const producer = recordProviderRequest({ ...planner, segment })
	const plan = savePlanMarkdown({ cwd: dir, name: "export", planText: "# Export\n", workId })
	appendWorkRecord(planner, { type: "plan", ...plan, requestId: producer.requestId })
	confirmWorkContinuation(
		planner,
		{ workId, source: "saved-plan", evidence: { path: plan.path, contentHash: plan.contentHash } },
		originalScope,
	)
	const automatic = readWorkRecords(dir).find((row) => row.type === "work_link")
	expect(automatic).toBeDefined()
	await correctWorkLink(planner, `unlink ${automatic?.linkId}`)
	const implementer = createContext({ cwd: dir, sessionManager: { getSessionId: () => "implementer" } })
	const target = getWorkId(implementer)
	scope.saveNewWorkScope(target, originalScope)
	recordProviderRequest(implementer)
	await correctWorkLink(implementer, `link ${workId} ${segment.id}`)
	expect(requestWorkLinks(readWorkRecords(dir)).get(producer.requestId)).toMatchObject({
		workIds: new Set([target]),
		unresolved: false,
	})
})

it("refuses an unlink from a work that a newer correction moved the requests away from", async () => {
	const workScope = createWorkScopeSnapshot(join(dir, ".git")).scope
	vi.spyOn(scope, "captureWorkScope").mockResolvedValue({ scope: workScope, isCurrent: () => true })
	const session = (name: string) => {
		const ctx = createContext({ cwd: dir, sessionManager: { getSessionId: () => name } })
		scope.saveNewWorkScope(getWorkId(ctx), workScope)
		recordProviderRequest(ctx)
		return ctx
	}
	const planner = session("planner")
	const segment = { id: randomUUID(), attribution: "session", reason: "matching-disabled" } as const
	const producer = recordProviderRequest({ ...planner, segment })
	const first = session("first")
	const second = session("second")
	await correctWorkLink(first, `link ${getWorkId(planner)} ${segment.id}`)
	await correctWorkLink(second, `link ${getWorkId(planner)} ${segment.id}`)
	const links = () =>
		readWorkRecords(dir)
			.filter((row) => row.type === "work_link")
			.sort((left, right) => Number(left.revision) - Number(right.revision))
	const saved = links()
	expect(saved.map((row) => [row.revision, row.targetWorkId])).toEqual([
		[1, getWorkId(first)],
		[2, getWorkId(second)],
	])
	await expect(correctWorkLink(first, `unlink ${saved[0].linkId}`)).rejects.toThrow(/moved this correction/)
	expect(links()).toEqual(saved)
	expect(requestWorkLinks(readWorkRecords(dir)).get(producer.requestId)).toMatchObject({
		workIds: new Set([getWorkId(second)]),
		unresolved: false,
	})
})

it("revokes a moved correction from its newest work with that revision's evidence", async () => {
	const originalScope = createWorkScopeSnapshot(join(dir, ".git")).scope
	vi.spyOn(scope, "captureWorkScope").mockResolvedValue({ scope: originalScope, isCurrent: () => true })
	const planner = createContext({ cwd: dir, sessionManager: { getSessionId: () => "planner" } })
	const workId = getWorkId(planner)
	scope.saveNewWorkScope(workId, originalScope)
	const segment = { id: randomUUID(), attribution: "session", reason: "planning" } as const
	const producer = recordProviderRequest({ ...planner, segment })
	const plan = savePlanMarkdown({ cwd: dir, name: "export", planText: "# Export\n", workId })
	appendWorkRecord(planner, { type: "plan", ...plan, requestId: producer.requestId })
	confirmWorkContinuation(
		planner,
		{ workId, source: "saved-plan", evidence: { path: plan.path, contentHash: plan.contentHash } },
		originalScope,
	)
	const implementer = createContext({ cwd: dir, sessionManager: { getSessionId: () => "implementer" } })
	const target = getWorkId(implementer)
	scope.saveNewWorkScope(target, originalScope)
	recordProviderRequest(implementer)
	await correctWorkLink(implementer, `link ${workId} ${segment.id}`)
	const links = () =>
		readWorkRecords(dir)
			.filter((row) => row.type === "work_link")
			.sort((left, right) => Number(left.revision) - Number(right.revision))
	const [automatic, moved] = links()
	expect(automatic.evidence).toMatchObject({ source: "saved-plan" })
	expect(moved.evidence).toMatchObject({ source: "work-command" })
	// The planner's work still lists the automatic confirmation, but no longer owns it.
	await expect(correctWorkLink(planner, `unlink ${automatic.linkId}`)).rejects.toThrow(/moved this correction/)
	await correctWorkLink(implementer, `unlink ${automatic.linkId}`)
	const revoked = links()[2]
	expect(revoked).toMatchObject({
		linkId: automatic.linkId,
		revision: 3,
		status: "revoked",
		sourceWorkId: workId,
		targetWorkId: target,
		requestIds: moved.requestIds,
		evidence: moved.evidence,
	})
	expect(requestWorkLinks(readWorkRecords(dir)).get(producer.requestId)).toMatchObject({ unresolved: true })
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
	if (kind === "ambiguous-producer")
		appendWorkRecord(flow.ctx, { ...flow.origin, requestId: flow.unrelated }, flow.workId)
	await repair()
	expect(links()).toEqual([])
})

for (const mode of ["live", "repair"] as const) {
	it.each([
		["confirms", null],
		["refuses", "88888888-8888-4888-8888-888888888888"],
	] as const)(`${mode} %s a plan whose work has an earlier request with %s scope`, async (outcome, organizationId) => {
		const ctx = createContext({ cwd: dir, sessionManager: { getSessionId: () => "planner" } })
		const workId = getWorkId(ctx)
		const originalScope = createWorkScopeSnapshot(join(dir, ".git")).scope
		// The first input ran before account verification finished, so its request kept no scope.
		const early = recordProviderRequest({
			...ctx,
			segment: { id: randomUUID(), attribution: "session", reason: "matching-disabled" },
		})
		scope.saveNewWorkScope(workId, originalScope)
		if (organizationId)
			appendWorkRecord(ctx, {
				type: "request",
				requestId: randomUUID(),
				scope: { ...originalScope, account: { ...originalScope.account, organizationId } },
			})
		const segment = { id: randomUUID(), attribution: "session", reason: "matching-disabled" } as const
		const producer = recordProviderRequest({ ...ctx, segment }).requestId
		const plan = savePlanMarkdown({ cwd: dir, name: "export", planText: "# Export\n", workId })
		appendWorkRecord(ctx, { type: "plan", ...plan, requestId: producer })
		expect(readWorkRecords(dir).find((row) => row.requestId === early.requestId)?.scope).toBeNull()
		const accepted: Pick<WorkContinuation, "source" | "evidence"> = {
			source: "saved-plan",
			evidence: {
				path: plan.path,
				contentHash: plan.contentHash,
				requestId: producer,
				segmentId: randomUUID(),
				...originalScope,
			},
		}
		if (mode === "live") confirmWorkContinuation(ctx, { workId, ...accepted }, originalScope)
		else {
			const consumer = createContext({ cwd: dir, sessionManager: { getSessionId: () => "consumer" } })
			appendWorkRecord(consumer, { type: "work", continuation: accepted }, workId)
			await repair()
		}
		const resolved = requestWorkLinks(readWorkRecords(dir)).get(producer)
		if (outcome === "refuses") expect(resolved).toBeUndefined()
		else expect(resolved).toMatchObject({ workIds: new Set([workId]), unresolved: false })
		expect(links()).toMatchObject(outcome === "refuses" ? [] : [{ requestIds: [producer] }])
	})
}

it.each(["session", "inferred"] as const)("confirms the restored %s planning input only", async (attribution) => {
	const flow = acceptedContinuation()
	const requests = readWorkRecords(dir).filter((row) => row.type === "request")
	for (const row of requests.filter((row) => row.requestId !== flow.unrelated)) {
		appendWorkRecord(flow.ctx, { ...row, segment: { ...flow.segment, attribution } }, flow.workId)
	}
	await repair()
	expect(links()).toHaveLength(1)
	expect(links()[0].requestIds).toEqual([flow.research, flow.producer].sort())
	expect(requestWorkLinks(readWorkRecords(dir)).has(flow.unrelated)).toBe(false)
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
		await expect(Promise.resolve().then(invoke)).rejects.toThrow(
			`Incomplete work history contains invalid records in ${damaged}:1`,
		)
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
		"other work",
		"continued work",
		"continued work's request",
	])(`${mode} handles an unknown record type that names the %s`, async (named) => {
		const flow = acceptedContinuation()
		const sibling = acceptedContinuation("plan", "sibling")
		await flushWorkSummaries()
		// A newer Kimchi sharing this history wrote a record type that this version cannot interpret.
		const newer = join(dir, "work-attribution", "newer.jsonl")
		const record = {
			version: 1,
			type: "work_checkpoint",
			workId: { "other work": sibling.workId, "continued work": flow.workId }[named] ?? randomUUID(),
			sessionId: "newer",
			...(named === "continued work's request" ? { requests: { [flow.research]: "moved" } } : {}),
		}
		fs.writeFileSync(newer, `${JSON.stringify(record)}\n`)
		const { requestId: _requestId, ...evidence } = flow.continuation.evidence
		const continuation = { ...flow.continuation, workId: flow.workId, evidence }
		const invoke = () =>
			mode === "pin"
				? pinWorkContinuation(continuation)
				: mode === "live"
					? confirmWorkContinuation(flow.ctx, continuation, flow.originalScope)
					: repair()
		if (named === "other work") {
			const pinned = await invoke()
			if (mode === "pin") expect(pinned).toMatchObject({ evidence: { requestId: flow.producer } })
			else expect(links()).toMatchObject([{ workId: flow.workId }])
		} else if (mode === "history") {
			// Only the named work waits; the other receipt is still confirmed in the same pass.
			await repair()
			expect(links()).toMatchObject([{ workId: sibling.workId }])
		} else {
			await expect(Promise.resolve().then(invoke)).rejects.toThrow(
				`Work history contains unknown record types in ${newer}:1`,
			)
			expect(links()).toEqual([])
		}
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

it("reads each journal once and no retained plan in an idle pass over confirmed receipts", async () => {
	for (let index = 0; index < 30; index++) acceptedContinuation("plan", `planner-${index}`)
	const progress = {}
	await repair(progress)
	await repair(progress)
	expect(links()).toHaveLength(30)
	await flushWorkSummaries()
	const read = vi.spyOn(fs, "readFileSync")
	await repair(progress)
	const paths = read.mock.calls.map(([path]) => String(path))
	const journals = paths.filter((path) => path.endsWith(".jsonl"))
	expect(journals).toHaveLength(60)
	expect(new Set(journals).size).toBe(60)
	expect(paths.filter((path) => path.endsWith(".md"))).toEqual([])
	expect(links()).toHaveLength(30)
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
