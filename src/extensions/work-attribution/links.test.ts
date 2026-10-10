import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { savePlanMarkdown } from "../../shared/planning/plan-markdown.js"
import { createContext } from "../__mocks__/context.js"
import { createWorkScopeSnapshot } from "../__mocks__/work-scope.js"
import { appendWorkRecord, getWorkId, recordProviderRequest } from "../work-attribution.js"
import { confirmWorkContinuation, correctWorkLink, requestWorkLinks } from "./links.js"
import * as scope from "./scope.js"
import { flushWorkSummaries, readWorkRecords, type WorkRecord } from "./summary.js"

let dir: string
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kimchi-work-link-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", dir)
})
afterEach(async () => {
	await flushWorkSummaries()
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
	confirmWorkContinuation(ctx, { workId, source: "saved-plan", evidence: { path: plan.path } }, originalScope)
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
	confirmWorkContinuation(planner, { workId, source: "saved-plan", evidence: { path: plan.path } }, originalScope)
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
	confirmWorkContinuation(planner, { workId, source: "saved-plan", evidence: { path: plan.path } }, originalScope)
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
