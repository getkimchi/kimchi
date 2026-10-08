import { createHash, randomUUID } from "node:crypto"
import { readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { isWorkId } from "../../shared/work-id.js"
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
import { readWorkRecords, SHA256_HEX, type WorkRecord } from "./summary.js"

interface RequestLink {
	workIds: Set<string>
	linkIds: Set<string>
	unresolved: boolean
}

const REPAIR_BUDGET_MS = 3000
const MAX_CONTINUATIONS_PER_PASS = 25
/** Rows between time-budget checks: a clock read per row is measurable on long histories. */
const BUDGET_CHECK_ROWS = 1024

/** Direct request corrections only: never merge sessions or follow transitive work links. */
export function requestWorkLinks(records: readonly WorkRecord[]): Map<string, RequestLink> {
	const groups = new Map<string, WorkRecord[]>()
	const requests = new Map<string, WorkRecord[]>()
	const workRequests = new Map<string, WorkRecord[]>()
	for (const row of records) {
		if (row.type === "request" && typeof row.requestId === "string") {
			const copies = requests.get(row.requestId) ?? []
			copies.push(row)
			requests.set(row.requestId, copies)
			const work = workRequests.get(row.workId) ?? []
			work.push(row)
			workRequests.set(row.workId, work)
		}
		if (row.type === "work_link" && typeof row.linkId === "string") {
			const history = groups.get(row.linkId) ?? []
			history.push(row)
			groups.set(row.linkId, history)
		}
	}
	const result = new Map<string, RequestLink>()
	for (const [linkId, rows] of groups) {
		const revision = Math.max(...rows.map((row) => (typeof row.revision === "number" ? row.revision : 0)))
		const latest = rows.filter((row) => row.revision === revision)
		const selected = latest[0]
		const fingerprints = new Set(
			latest.map((row) =>
				JSON.stringify([
					row.workId,
					row.sourceWorkId,
					row.targetWorkId,
					row.status,
					isWorkScope(row.scope)
						? [
								row.scope.repository,
								row.scope.account.apiUrl,
								row.scope.account.organizationId,
								row.scope.account.userId,
							]
						: null,
					Array.isArray(row.requestIds) ? [...row.requestIds].sort() : null,
					row.evidence,
				]),
			),
		)
		const ids = new Set(
			rows.flatMap((row) =>
				Array.isArray(row.requestIds) ? row.requestIds.filter((id): id is string => typeof id === "string") : [],
			),
		)
		const scope = selected && isWorkScope(selected.scope) ? selected.scope : undefined
		const target = selected && typeof selected.targetWorkId === "string" ? selected.targetWorkId : ""
		const targetRequests = workRequests.get(target) ?? []
		const selectedIds = Array.isArray(selected?.requestIds) ? selected.requestIds : []
		const evidence = selected?.evidence && typeof selected.evidence === "object" ? selected.evidence : undefined
		const automatic =
			evidence &&
			"source" in evidence &&
			(evidence.source === "saved-plan" || evidence.source === "pasted-plan" || evidence.source === "named-artifact")
		const valid =
			selected &&
			scope &&
			isWorkId(linkId) &&
			Number.isSafeInteger(revision) &&
			revision > 0 &&
			fingerprints.size === 1 &&
			selected.status === "active" &&
			isWorkId(selected.sourceWorkId) &&
			isWorkId(target) &&
			selected.workId === target &&
			selectedIds.length > 0 &&
			selectedIds.every(isWorkId) &&
			evidence &&
			"source" in evidence &&
			(evidence.source === "work-command" ||
				(automatic &&
					selected.sourceWorkId === target &&
					"requestId" in evidence &&
					isWorkId(evidence.requestId) &&
					selectedIds.includes(evidence.requestId) &&
					"segmentId" in evidence &&
					isWorkId(evidence.segmentId))) &&
			// Requests before a new work's delayed first scope stay unscoped; only another scope conflicts.
			targetRequests.some((row) => isWorkScope(row.scope)) &&
			targetRequests.every((row) => !isWorkScope(row.scope) || sameWorkScope(row.scope, scope))
		for (const requestId of ids) {
			const value = result.get(requestId) ?? { workIds: new Set(), linkIds: new Set(), unresolved: false }
			for (const row of valid ? latest : rows)
				if (typeof row.targetWorkId === "string") value.workIds.add(row.targetWorkId)
			value.linkIds.add(linkId)
			const originals = requests.get(requestId) ?? []
			value.unresolved ||=
				!valid ||
				!selectedIds.includes(requestId) ||
				!originals.length ||
				!originals.every(
					(row) =>
						row.workId === selected.sourceWorkId &&
						isWorkScope(row.scope) &&
						sameWorkScope(row.scope, scope) &&
						(!automatic ||
							(isWorkSegment(row.segment) && "segmentId" in evidence && row.segment.id === evidence.segmentId)),
				)
			result.set(requestId, value)
		}
	}
	for (const value of result.values()) value.unresolved ||= value.workIds.size !== 1
	return result
}

function continuationRecords(agentDir: string, checkBudget?: () => void): WorkRecord[] {
	let invalid = false
	const records = readWorkRecords(agentDir, undefined, checkBudget, () => {
		invalid = true
	})
	if (invalid) throw new Error("Incomplete work history contains invalid records")
	return records
}

/** Lookups over one journal snapshot, so checking a receipt never rescans the whole history. */
interface ContinuationIndex {
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

function indexContinuationRecords(
	records: readonly WorkRecord[],
	checkBudget: () => void = () => {},
): ContinuationIndex {
	const index: ContinuationIndex = {
		linked: new Set(),
		requests: new Map(),
		workRequests: new Map(),
		segmentRequests: new Map(),
		plans: new Map(),
		transitions: new Map(),
	}
	for (let position = 0; position < records.length; position++) {
		if (position % BUDGET_CHECK_ROWS === 0) checkBudget()
		indexRecord(index, records[position])
	}
	return index
}

function continuationProducers(
	continuation: WorkContinuation,
	index: ContinuationIndex,
	checkBudget: () => void = () => {},
) {
	const { workId, source, evidence } = continuation
	if (source === "semantic") return []
	if (source === "named-artifact")
		return isWorkId(evidence.transitionId) ? (index.transitions.get(workId + evidence.transitionId) ?? []) : []
	const { contentHash } = evidence
	if (typeof contentHash !== "string" || !SHA256_HEX.test(contentHash)) return []
	const producers = (index.plans.get(workId + contentHash) ?? []).filter((row) =>
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
			return createHash("sha256").update(saved).digest("hex") === contentHash
		} catch {
			return false
		}
	})
	return retained ? producers : []
}

/** Keep a known producer's identity even if its source journal is unavailable during a later pass. */
export function pinWorkContinuation(continuation: WorkContinuation): WorkContinuation {
	const producers = continuationProducers(continuation, indexContinuationRecords(continuationRecords(getAgentDir())))
	const ids = new Set(producers.map((row) => row.requestId))
	const requestId = producers[0]?.requestId
	if (!isWorkId(requestId) || !producers.every((row) => isWorkId(row.requestId)) || ids.size !== 1) return continuation
	return { ...continuation, evidence: { ...continuation.evidence, requestId } }
}

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
	if (
		!isWorkSegment(segment) ||
		!isWorkId(segment.id) ||
		segment.attribution === "explicit" ||
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
	if (
		// An existing correction or confirmation takes precedence, even when it was revoked.
		requestIds.some((id) => index.linked.has(id)) ||
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
export function confirmWorkContinuation(ctx: WorkContext, continuation: WorkContinuation, scope: WorkScope): void {
	if (getWorkId(ctx) !== continuation.workId) return
	const link = continuationLink(continuation, scope, indexContinuationRecords(continuationRecords(getAgentDir())))
	if (link) appendWorkRecord(ctx, link, continuation.workId)
}

function acceptedContinuation(row: WorkRecord): WorkContinuation | undefined {
	if (row.type !== "work" || !row.continuation || typeof row.continuation !== "object") return
	const value = row.continuation
	if (!("source" in value) || !("evidence" in value)) return
	const { source, evidence } = value
	if (source !== "saved-plan" && source !== "pasted-plan" && source !== "named-artifact") return
	if (!evidence || typeof evidence !== "object" || !("path" in evidence) || typeof evidence.path !== "string") return
	return { workId: row.workId, source, evidence: { ...evidence, path: evidence.path } }
}

/** Retry accepted evidence locally; unresolved receipts are never marked permanently complete. */
export async function reconcileWorkContinuations(
	agentDir: string,
	signal: AbortSignal,
	assertLease: () => void,
	progress: { nextContinuation?: string } = {},
): Promise<void> {
	const deadline = Date.now() + REPAIR_BUDGET_MS
	const checkBudget = () => {
		signal.throwIfAborted()
		assertLease()
		if (Date.now() > deadline) throw new Error("Work continuation reconciliation time limit exceeded")
	}
	const records = continuationRecords(agentDir, checkBudget)
	const index = indexContinuationRecords(records, checkBudget)
	const candidates = new Map<string, { row: WorkRecord; continuation: WorkContinuation }>()
	for (const row of records) {
		const continuation = acceptedContinuation(row)
		// A linked producer is already confirmed or corrected, and its link would be refused anyway.
		if (continuation && typeof row.cwd === "string" && !index.linked.has(continuation.evidence.requestId))
			candidates.set(JSON.stringify([row.workId, row.sessionId, continuation]), { row, continuation })
	}
	const keys = [...candidates.keys()].sort()
	const start = Math.max(0, keys.indexOf(progress.nextContinuation ?? ""))
	for (let offset = 0; offset < Math.min(keys.length, MAX_CONTINUATIONS_PER_PASS); offset++) {
		checkBudget()
		const position = (start + offset) % keys.length
		// A slow or broken receipt yields its place; it remains eligible on a later pass.
		progress.nextContinuation = keys[(position + 1) % keys.length]
		const candidate = candidates.get(keys[position])
		if (!candidate) continue
		const { row, continuation } = candidate
		const acceptedAt = typeof row.recordedAt === "string" ? Date.parse(row.recordedAt) : Number.NaN
		if (continuation.source !== "named-artifact" && !Number.isFinite(acceptedAt)) continue
		const scope = readWorkScope(row.workId)
		if (!scope) continue
		const link = continuationLink(continuation, scope, index, checkBudget, acceptedAt)
		if (!link) continue
		checkBudget()
		appendWorkRecord(
			{ cwd: String(row.cwd), sessionManager: { getSessionId: () => row.sessionId } },
			link,
			row.workId,
			join(agentDir, "work-attribution", `${encodeURIComponent(row.sessionId)}.jsonl`),
		)
		indexRecord(index, { ...link, version: 1, workId: row.workId, sessionId: row.sessionId })
	}
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
