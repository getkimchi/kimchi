import { createHash, randomUUID } from "node:crypto"
import { readFileSync, realpathSync } from "node:fs"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { isWorkId } from "@getkimchi/kimchi-bridge/ledger"
import { preludeStretch } from "../../shared/prelude-stretch.js"
import { appendWorkRecord, getWorkId, isWorkSegment, type WorkContext } from "../work-attribution.js"
import type { WorkContinuation } from "./continuation.js"
import {
	captureWorkScope,
	isWorkAccount,
	isWorkScope,
	readWorkScope,
	sameWorkAccount,
	sameWorkScope,
	type WorkScope,
} from "./scope.js"
import {
	object,
	readWorkRecords,
	readWorkRecordsForHistoryAsync,
	SHA256_HEX,
	type WorkRecord,
	type WorkRecordProblem,
} from "./summary.js"

/** Rows between time-budget checks: a clock read per row is measurable on long histories. */
const BUDGET_CHECK_ROWS = 1024

/** Lookups over one journal snapshot, so checking a receipt never rescans the whole history. */
interface ContinuationIndex {
	/** Indexed rows so far — the exact retained-row count the eviction cap reads (O(1)). */
	retainedRows: number
	/** Request IDs named by any correction or confirmation, whatever its revision or status. */
	linked: Set<unknown>
	/** Request rows in journal order by request ID, by work, and by work plus input segment. */
	requests: Map<string, WorkRecord[]>
	workRequests: Map<string, WorkRecord[]>
	segmentRequests: Map<string, WorkRecord[]>
	/** Possible producers in journal order: plans by work plus content hash, native edits by work plus transition. */
	plans: Map<string, WorkRecord[]>
	transitions: Map<string, WorkRecord[]>
}

function addRow(rows: Map<string, WorkRecord[]>, key: string, row: WorkRecord): void {
	const existing = rows.get(key)
	if (existing) existing.push(row)
	else rows.set(key, [row])
}

// Work IDs are fixed-length UUIDs, so prefixing one keeps each composite key unambiguous.
function indexRecord(index: ContinuationIndex, row: WorkRecord): void {
	index.retainedRows++
	if (row.type === "work_link" && Array.isArray(row.requestIds)) for (const id of row.requestIds) index.linked.add(id)
	else if (row.type === "request" && typeof row.requestId === "string") {
		addRow(index.requests, row.requestId, row)
		addRow(index.workRequests, row.workId, row)
		if (isWorkSegment(row.segment)) addRow(index.segmentRequests, row.workId + row.segment.id, row)
	} else if (row.type === "plan" && typeof row.contentHash === "string")
		addRow(index.plans, row.workId + row.contentHash, row)
	else if (row.type === "file_transition" && typeof row.transitionId === "string")
		addRow(index.transitions, row.workId + row.transitionId, row)
}

function newContinuationIndex(): ContinuationIndex {
	return {
		linked: new Set(),
		requests: new Map(),
		workRequests: new Map(),
		segmentRequests: new Map(),
		plans: new Map(),
		transitions: new Map(),
		retainedRows: 0,
	}
}

function indexContinuationRecords(
	records: readonly WorkRecord[],
	checkBudget: () => void = () => {},
): ContinuationIndex {
	const index = newContinuationIndex()
	for (let position = 0; position < records.length; position++) {
		if (position % BUDGET_CHECK_ROWS === 0) checkBudget()
		indexRecord(index, records[position])
	}
	return index
}

/** The same index, breathing between rows for a caller driving the UI loop. */
async function indexContinuationRecordsAsync(
	records: readonly WorkRecord[],
	checkBudget: () => void,
	stretch: () => Promise<void>,
): Promise<ContinuationIndex> {
	const index = newContinuationIndex()
	for (let position = 0; position < records.length; position++) {
		await stretch()
		if (position % BUDGET_CHECK_ROWS === 0) checkBudget()
		indexRecord(index, records[position])
	}
	return index
}

/** One complete journal snapshot for continuation checks. */
export interface ContinuationHistory {
	records: WorkRecord[]
	index: ContinuationIndex
	/** Complete records of types this version does not know, with every UUID each one names. */
	unknown: { problem: WorkRecordProblem; ids: Set<string> }[]
}

/** Every UUID a record names: an unknown record type may concern any of those works or requests. */
function namedIds(value: unknown, ids = new Set<string>()): Set<string> {
	if (isWorkId(value)) ids.add(value)
	else if (Array.isArray(value)) for (const item of value) namedIds(item, ids)
	else if (object(value))
		for (const [key, item] of Object.entries(value)) {
			if (isWorkId(key)) ids.add(key)
			namedIds(item, ids)
		}
	return ids
}

/** Names each affected journal once, with its first problem line, so it can be found and repaired. */
function journals(problems: readonly WorkRecordProblem[]): string {
	const lines = new Map<string, number>()
	for (const { path, line } of problems) if (!lines.has(path)) lines.set(path, line)
	const named = [...lines].map(([path, line]) => `${path}:${line}`)
	return named.length > 3 ? `${named.slice(0, 3).join(", ")} and ${named.length - 3} more` : named.join(", ")
}

/** Damage anywhere could hide a revocation, so it blocks every confirmation until the journal is repaired. */
export function readContinuationHistory(agentDir: string, checkBudget?: () => void): ContinuationHistory {
	const invalid: WorkRecordProblem[] = []
	const unknown: ContinuationHistory["unknown"] = []
	const records = readWorkRecords(agentDir, undefined, checkBudget, (problem) => {
		if (problem.kind === "invalid") invalid.push(problem)
		else unknown.push({ problem, ids: namedIds(problem.record) })
	})
	if (invalid.length) throw new Error(`Incomplete work history contains invalid records in ${journals(invalid)}`)
	return { records, index: indexContinuationRecords(records, checkBudget), unknown }
}

/** The same snapshot, breathing through the ledger walk and the index build. `mergedSince` also
 * collects the record hashes of rows imported at or after it — from this read's own snapshot, never a
 * later one — so the caller's incremental-overlap memory covers only rows it also indexed. */
export async function readContinuationHistoryAsync(
	agentDir: string,
	checkBudget: () => void = () => {},
	stretch: () => Promise<void> = preludeStretch(),
	mergedSince?: number,
): Promise<ContinuationHistory & { merged: Set<string> }> {
	const invalid: WorkRecordProblem[] = []
	const unknown: ContinuationHistory["unknown"] = []
	const anchored = await readWorkRecordsForHistoryAsync(agentDir, checkBudget, stretch, (problem) => {
		if (problem.kind === "invalid") invalid.push(problem)
		else unknown.push({ problem, ids: namedIds(problem.record) })
	})
	if (invalid.length) throw new Error(`Incomplete work history contains invalid records in ${journals(invalid)}`)
	const records = anchored.map((row) => row.record)
	const merged = new Set<string>()
	for (const { hash, importedAt } of anchored)
		if (mergedSince !== undefined && importedAt >= mergedSince) merged.add(hash)
	return { records, index: await indexContinuationRecordsAsync(records, checkBudget, stretch), unknown, merged }
}

/** Unknown record types naming this work or one of its requests; this version cannot tell what they change. */
function unknownRecords(history: Pick<ContinuationHistory, "index" | "unknown">, workId: string): WorkRecordProblem[] {
	return history.unknown
		.filter(({ ids }) =>
			[...ids].some((id) => id === workId || history.index.requests.get(id)?.some((row) => row.workId === workId)),
		)
		.map(({ problem }) => problem)
}

/** A newer record type blocks only the work it concerns; unrelated works stay decidable. */
function workIndex(history: ContinuationHistory, workId: string): ContinuationIndex {
	const unknown = unknownRecords(history, workId)
	if (unknown.length) throw new Error(`Work history contains unknown record types in ${journals(unknown)}`)
	return history.index
}

/** Index key of the records that can have produced an accepted plan or artifact; a receipt without one never resolves. */
function producerKey({ workId, source, evidence }: WorkContinuation): string | undefined {
	if (source === "named-artifact") return isWorkId(evidence.transitionId) ? workId + evidence.transitionId : undefined
	// Plan receipts saved before acceptance hashes cannot tell the accepted version apart.
	if (source !== "semantic" && typeof evidence.contentHash === "string" && SHA256_HEX.test(evidence.contentHash))
		return workId + evidence.contentHash
}

function continuationProducers(
	continuation: WorkContinuation,
	index: ContinuationIndex,
	checkBudget: () => void = () => {},
) {
	const { source, evidence } = continuation
	const key = producerKey(continuation)
	if (!key) return []
	if (source === "named-artifact") return index.transitions.get(key) ?? []
	const producers = (index.plans.get(key) ?? []).filter((row) =>
		[row.path, row.snapshotPath].some((path) => {
			if (typeof path !== "string") return false
			if (path === evidence.path) return true
			try {
				return realpathSync(path) === evidence.path
			} catch {
				return false
			}
		}),
	)
	// Missing or damaged bytes cannot eliminate a competing producer and make ownership certain.
	const retained = producers.every((row) => {
		checkBudget()
		try {
			if (typeof row.snapshotPath !== "string") return false
			const saved = readFileSync(row.snapshotPath)
			return createHash("sha256").update(saved).digest("hex") === evidence.contentHash
		} catch {
			return false
		}
	})
	return retained ? producers : []
}

/** Keep a known producer's identity even if its source journal is unavailable during a later pass. */
export function pinWorkContinuation(continuation: WorkContinuation, history: ContinuationHistory): WorkContinuation {
	const producers = continuationProducers(continuation, workIndex(history, continuation.workId))
	const ids = new Set(producers.map((row) => row.requestId))
	const requestId = producers[0]?.requestId
	if (!isWorkId(requestId) || !producers.every((row) => isWorkId(row.requestId)) || ids.size !== 1) return continuation
	return { ...continuation, evidence: { ...continuation.evidence, requestId } }
}

/** Null when the receipt can never link; undefined while missing or conflicting evidence leaves it unresolved. */
function continuationLink(
	continuation: WorkContinuation,
	scope: WorkScope,
	index: ContinuationIndex,
	checkBudget: () => void = () => {},
	acceptedAt?: number,
) {
	const { workId, source, evidence } = continuation
	const originalScope = readWorkScope(workId)
	if (
		!originalScope ||
		!sameWorkScope(originalScope, scope) ||
		(evidence.repository !== undefined && evidence.repository !== scope.repository) ||
		(evidence.account !== undefined &&
			(!isWorkAccount(evidence.account) || !sameWorkAccount(evidence.account, scope.account))) ||
		(evidence.requestId !== undefined && !isWorkId(evidence.requestId))
	)
		return
	const producers = continuationProducers(continuation, index, checkBudget).filter((row) => {
		// A later identical save cannot explain an earlier acceptance. Restored source
		// records retain their original timestamp; genuinely later production stays unknown.
		return (
			source === "named-artifact" ||
			evidence.requestId !== undefined ||
			acceptedAt === undefined ||
			(typeof row.recordedAt === "string" &&
				Number.isFinite(Date.parse(row.recordedAt)) &&
				Date.parse(row.recordedAt) < acceptedAt)
		)
	})
	if (!producers.length || !producers.every((row) => isWorkId(row.requestId))) return
	const producerIds = new Set(producers.map((row) => row.requestId))
	if (producerIds.size !== 1 || (evidence.requestId !== undefined && !producerIds.has(evidence.requestId))) return
	const origins = index.requests.get(String(producers[0].requestId)) ?? []
	const segment = origins[0]?.segment
	// An explicit input already chose its work, so there is nothing to confirm.
	if (isWorkSegment(segment) && segment.attribution === "explicit") return null
	if (
		!isWorkSegment(segment) ||
		!isWorkId(segment.id) ||
		!origins.every(
			(row) =>
				row.workId === workId &&
				isWorkSegment(row.segment) &&
				row.segment.id === segment.id &&
				isWorkScope(row.scope) &&
				sameWorkScope(row.scope, scope),
		)
	)
		return
	const requests = index.segmentRequests.get(workId + segment.id) ?? []
	if (!requests.every((row) => isWorkId(row.requestId) && isWorkScope(row.scope) && sameWorkScope(row.scope, scope)))
		return
	const requestIds = [...new Set(requests.map((row) => String(row.requestId)))].sort()
	// An existing correction or confirmation takes precedence, even when it was revoked.
	if (requestIds.some((id) => index.linked.has(id))) return null
	if (
		// Requests before a new work's delayed first scope stay unscoped; only another scope conflicts.
		(index.workRequests.get(workId) ?? []).some((row) => isWorkScope(row.scope) && !sameWorkScope(row.scope, scope)) ||
		requestIds.some((id) =>
			(index.requests.get(id) ?? []).some(
				(row) =>
					row.workId !== workId ||
					!isWorkSegment(row.segment) ||
					row.segment.id !== segment.id ||
					!isWorkScope(row.scope) ||
					!sameWorkScope(row.scope, scope),
			),
		)
	)
		return
	checkBudget()
	return {
		type: "work_link" as const,
		linkId: randomUUID(),
		revision: 1,
		status: "active",
		sourceWorkId: workId,
		targetWorkId: workId,
		requestIds,
		scope,
		evidence: { ...evidence, source, requestId: origins[0].requestId, segmentId: segment.id },
	}
}

/** Confirm the producer's input after a verified continuation; never override an existing correction. */
export function confirmWorkContinuation(
	ctx: WorkContext,
	continuation: WorkContinuation,
	scope: WorkScope,
	history: ContinuationHistory,
): void {
	if (getWorkId(ctx) !== continuation.workId) return
	const link = continuationLink(continuation, scope, workIndex(history, continuation.workId))
	if (link) appendWorkRecord(ctx, link, continuation.workId)
}

/** Explicit repair chooses one input segment; choosing its current work confirms an uncertain assignment. */
export async function correctWorkLink(ctx: WorkContext, args: string): Promise<string> {
	const [command, id, segmentId, ...extra] = args.split(/\s+/)
	if (
		!isWorkId(id) ||
		extra.length ||
		(command === "link" ? !isWorkId(segmentId) : command !== "unlink" || segmentId !== undefined)
	)
		throw new Error("Use /work link <source-work-id> <segment-id> or /work unlink <link-id>")
	const targetWorkId = getWorkId(ctx)
	const cwd = ctx.cwd
	const captured = await captureWorkScope(cwd)
	const targetScope = readWorkScope(targetWorkId)
	if (
		!captured?.isCurrent() ||
		ctx.cwd !== cwd ||
		!targetScope ||
		!sameWorkScope(targetScope, captured.scope) ||
		getWorkId(ctx) !== targetWorkId
	)
		throw new Error("Work correction needs the original account and repository")
	const records = readWorkRecords(getAgentDir())
	let existing: WorkRecord[]
	let requestIds: string[]
	let sourceWorkId: string
	let evidence: unknown
	if (command === "link") {
		const sourceScope = readWorkScope(id)
		const selected = records.filter(
			(row) =>
				row.type === "request" && row.workId === id && isWorkSegment(row.segment) && row.segment.id === segmentId,
		)
		if (
			!sourceScope ||
			!sameWorkScope(sourceScope, captured.scope) ||
			!selected.length ||
			!selected.every(
				(row) => isWorkId(row.requestId) && isWorkScope(row.scope) && sameWorkScope(row.scope, captured.scope),
			)
		)
			throw new Error("The selected requests need matching account and repository evidence")
		requestIds = [...new Set(selected.map((row) => String(row.requestId)))].sort()
		sourceWorkId = id
		const overlapping = new Set(
			records
				.filter(
					(row) =>
						row.type === "work_link" &&
						Array.isArray(row.requestIds) &&
						row.requestIds.some((requestId) => requestIds.includes(requestId)),
				)
				.map((row) => row.linkId),
		)
		existing = records.filter((row) => row.type === "work_link" && overlapping.has(row.linkId))
		evidence = { source: "work-command", segmentId }
	} else {
		// A later /work link can move this correction elsewhere; only the work of its newest revision may revoke it.
		existing = records.filter((row) => row.type === "work_link" && row.linkId === id)
		const revision = Math.max(0, ...existing.map((row) => (typeof row.revision === "number" ? row.revision : 0)))
		const latest = existing.filter((row) => row.revision === revision)
		if (latest.some((row) => row.targetWorkId !== targetWorkId))
			throw new Error("A later revision moved this correction to another work; unlink it there")
		const previous = latest[0]
		if (
			!previous ||
			!isWorkId(previous.sourceWorkId) ||
			!Array.isArray(previous.requestIds) ||
			!previous.requestIds.every(isWorkId)
		)
			throw new Error("No matching correction in the current work")
		requestIds = [
			...new Set(existing.flatMap((row) => (Array.isArray(row.requestIds) ? row.requestIds.filter(isWorkId) : []))),
		].sort()
		sourceWorkId = previous.sourceWorkId
		evidence = previous.evidence
	}
	if (
		existing.some(
			(row) =>
				!isWorkId(row.linkId) ||
				row.sourceWorkId !== sourceWorkId ||
				typeof row.revision !== "number" ||
				!Number.isSafeInteger(row.revision) ||
				row.revision < 1,
		)
	)
		throw new Error("Existing work correction is damaged")
	const linkIds = existing.length ? [...new Set(existing.map((row) => String(row.linkId)))] : [randomUUID()]
	if (!captured.isCurrent() || getWorkId(ctx) !== targetWorkId) throw new Error("Work changed during correction")
	for (const linkId of linkIds) {
		const revision =
			1 + Math.max(0, ...existing.filter((row) => row.linkId === linkId).map((row) => Number(row.revision)))
		appendWorkRecord(ctx, {
			type: "work_link",
			linkId,
			revision,
			sourceWorkId,
			targetWorkId,
			requestIds,
			scope: captured.scope,
			status: command === "link" ? "active" : "revoked",
			evidence,
		})
	}
	return `Work correction ${command === "link" ? "saved" : "revoked"}: ${linkIds.join(", ")}. Original request IDs are unchanged.`
}
