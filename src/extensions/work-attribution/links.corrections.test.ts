import { randomUUID } from "node:crypto"
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { savePlanMarkdown } from "../../shared/planning/plan-markdown.js"
import { createContext } from "../__mocks__/context.js"
import { createWorkScopeSnapshot } from "../__mocks__/work-scope.js"
import { appendWorkRecord, getWorkId, recordProviderRequest, workLedgerPath } from "../work-attribution.js"
import { calculatePullRequestCosts } from "./costs.js"
import { confirmWorkContinuation, correctWorkLink, reconcileWorkContinuations } from "./links.js"
import * as scope from "./scope.js"
import { flushWorkSummaries, readWorkRecords } from "./summary.js"

let dir: string
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kimchi-link-corrections-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", dir)
	vi.spyOn(scope, "captureWorkScope").mockResolvedValue(createWorkScopeSnapshot(join(dir, ".git")))
})
afterEach(async () => {
	await flushWorkSummaries()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	rmSync(dir, { recursive: true, force: true })
})

function planned() {
	const planner = createContext({ cwd: dir, sessionManager: { getSessionId: () => "planner" } })
	const workId = getWorkId(planner)
	const original = createWorkScopeSnapshot(join(dir, ".git")).scope
	scope.saveNewWorkScope(workId, original)
	const segment = { id: randomUUID(), attribution: "unknown", reason: "unresolved-reference" } as const
	recordProviderRequest({ ...planner, segment })
	const producer = recordProviderRequest({ ...planner, segment }).requestId
	const saved = savePlanMarkdown({ cwd: dir, name: "plan", planText: "# Plan\n", workId })
	if (!saved.snapshotPath || !saved.contentHash) throw new Error("Missing retained plan")
	appendWorkRecord(planner, { type: "plan", ...saved, requestId: producer }, workId)
	const continuation = {
		workId,
		source: "saved-plan" as const,
		evidence: {
			path: saved.snapshotPath,
			contentHash: saved.contentHash,
			requestId: producer,
			segmentId: randomUUID(),
			...original,
		},
	}
	return { planner, workId, original, segment, producer, continuation }
}

it("lets a user correction move automatically confirmed planning requests after revoking the confirmation", async () => {
	const flow = planned()
	confirmWorkContinuation(flow.planner, flow.continuation, flow.original)
	const auto = readWorkRecords(dir).filter((row) => row.type === "work_link")
	expect(auto).toHaveLength(1)
	// The user revokes the automatic confirmation in the planning work...
	await correctWorkLink(flow.planner, `unlink ${auto[0].linkId}`)
	// ...and links that planning input to the implementing work instead.
	const implementer = createContext({ cwd: dir, sessionManager: { getSessionId: () => "implementer" } })
	const target = getWorkId(implementer)
	scope.saveNewWorkScope(target, flow.original)
	recordProviderRequest(implementer)
	await correctWorkLink(implementer, `link ${flow.workId} ${flow.segment.id}`)
	const report = calculatePullRequestCosts(readWorkRecords(dir), [
		{ requestId: flow.producer, billingRecordId: flow.producer, costUsd: "0.125", account: flow.original.account },
	])
	const row = report.requests.find((request) => request.requestId === flow.producer)
	expect({ linkedWorkIds: row?.linkedWorkIds, reason: "reason" in (row ?? {}) ? row?.reason : undefined }).toEqual({
		linkedWorkIds: [target],
		reason: undefined,
	})
})

it("still repairs history after an unrelated session ledger kept a torn final append", async () => {
	const flow = planned()
	const consumer = createContext({ cwd: dir, sessionManager: { getSessionId: () => "consumer" } })
	appendWorkRecord(
		consumer,
		{ type: "work", continuation: { source: flow.continuation.source, evidence: flow.continuation.evidence } },
		flow.workId,
	)
	// Another session crashed mid-append (acknowledged in getWorkId: "A process may have died during its final append").
	appendFileSync(join(dir, "work-attribution", "crashed.jsonl"), '{"type":"request","requestId":"0b8f')
	const pass = () => reconcileWorkContinuations(dir, new AbortController().signal, () => {}, {})
	await pass().catch(() => {})
	await pass().catch(() => {})
	expect(readWorkRecords(dir).filter((row) => row.type === "work_link")).toHaveLength(1)
})

it("control: the same receipt repairs when no torn line exists", async () => {
	const flow = planned()
	const consumer = createContext({ cwd: dir, sessionManager: { getSessionId: () => "consumer" } })
	appendWorkRecord(
		consumer,
		{ type: "work", continuation: { source: flow.continuation.source, evidence: flow.continuation.evidence } },
		flow.workId,
	)
	await reconcileWorkContinuations(dir, new AbortController().signal, () => {}, {})
	expect(readWorkRecords(dir).filter((row) => row.type === "work_link")).toHaveLength(1)
})

it.each([16, 80_000])("repairs history after appending past a torn %i-byte tail", async (bytes) => {
	const flow = planned()
	const before = readWorkRecords(dir)
	appendFileSync(workLedgerPath(flow.planner), `{"partial":"${"x".repeat(bytes)}`)
	const requestId = recordProviderRequest(flow.planner).requestId
	const invalid = vi.fn()
	const rows = readWorkRecords(dir, undefined, undefined, invalid)
	expect(invalid).not.toHaveBeenCalled()
	expect(rows).toEqual([...before, expect.objectContaining({ type: "request", requestId })])
	const consumer = createContext({ cwd: dir, sessionManager: { getSessionId: () => "consumer" } })
	appendWorkRecord(
		consumer,
		{ type: "work", continuation: { source: flow.continuation.source, evidence: flow.continuation.evidence } },
		flow.workId,
	)
	await reconcileWorkContinuations(dir, new AbortController().signal, () => {}, {})
	expect(readWorkRecords(dir).filter((row) => row.type === "work_link")).toHaveLength(1)
})

it("control: without the automatic confirmation the same unlink/link sequence resolves to the target", async () => {
	const flow = planned()
	const implementer = createContext({ cwd: dir, sessionManager: { getSessionId: () => "implementer" } })
	const target = getWorkId(implementer)
	scope.saveNewWorkScope(target, flow.original)
	recordProviderRequest(implementer)
	await correctWorkLink(implementer, `link ${flow.workId} ${flow.segment.id}`)
	const report = calculatePullRequestCosts(readWorkRecords(dir), [
		{ requestId: flow.producer, billingRecordId: flow.producer, costUsd: "0.125", account: flow.original.account },
	])
	expect(report.requests.find((request) => request.requestId === flow.producer)?.linkedWorkIds).toEqual([target])
})

it("never removes journal bytes when appending after a torn tail", async () => {
	const flow = planned()
	const path = workLedgerPath(flow.planner)
	appendFileSync(path, '{"partial":"interrupted')
	const before = readFileSync(path, "utf8")
	const requestId = recordProviderRequest(flow.planner).requestId
	// Another process may already have appended here; truncating would erase its record.
	expect(readFileSync(path, "utf8").startsWith(before)).toBe(true)
	const invalid = vi.fn()
	expect(readWorkRecords(dir, undefined, undefined, invalid)).toContainEqual(
		expect.objectContaining({ type: "request", requestId }),
	)
	expect(invalid).not.toHaveBeenCalled()
})

it("keeps both records when two writers append after the same torn tail", () => {
	const flow = planned()
	const before = readWorkRecords(dir)
	const record = (requestId: string) => JSON.stringify({ ...before[0], requestId })
	// Both writers saw the unterminated tail before either append landed.
	appendFileSync(workLedgerPath(flow.planner), `{"partial":"interrupted\n${record("first")}\n\n${record("second")}\n`)
	const invalid = vi.fn()
	const rows = readWorkRecords(dir, undefined, undefined, invalid)
	expect(rows.map((row) => row.requestId)).toEqual([...before.map((row) => row.requestId), "first", "second"])
	expect(invalid).not.toHaveBeenCalled()
})

it("still fails closed on a damaged line that is not a cut-off record", () => {
	const flow = planned()
	appendFileSync(workLedgerPath(flow.planner), '{"partial":"interrupted"}}\n')
	recordProviderRequest(flow.planner)
	const invalid = vi.fn()
	readWorkRecords(dir, undefined, undefined, invalid)
	expect(invalid).toHaveBeenCalledOnce()
})
