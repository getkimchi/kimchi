import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createWorkScopeSnapshot } from "../__mocks__/work-scope.js"
import { getWorkId, recordProviderRequest } from "../work-attribution.js"
import { correctWorkLink } from "./links.js"
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
