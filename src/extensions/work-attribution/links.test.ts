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
import { flushWorkSummaries, readWorkRecords } from "./summary.js"

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
