import { createHash, randomUUID } from "node:crypto"
import { readFileSync, realpathSync } from "node:fs"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { isWorkId } from "../../shared/work-id.js"
import { appendWorkRecord, getWorkId, isWorkSegment, type WorkContext } from "../work-attribution.js"
import type { WorkContinuation } from "./continuation.js"
import { captureWorkScope, isWorkScope, readWorkScope, sameWorkScope, type WorkScope } from "./scope.js"
import { readWorkRecords, type WorkRecord } from "./summary.js"

interface RequestLink {
	workIds: Set<string>
	linkIds: Set<string>
	unresolved: boolean
}

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
			targetRequests.length > 0 &&
			targetRequests.every((row) => isWorkScope(row.scope) && sameWorkScope(row.scope, scope))
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

/** Confirm the producer's input after a verified continuation; never override an existing correction. */
export function confirmWorkContinuation(
	ctx: WorkContext,
	continuation: WorkContinuation,
	scope: WorkScope,
	records?: readonly WorkRecord[],
): void {
	if (continuation.source === "semantic" || getWorkId(ctx) !== continuation.workId) return
	records ??= readWorkRecords(getAgentDir())
	const { workId, source, evidence } = continuation
	const producers = records.filter((row) => {
		if (row.workId !== workId) return false
		if (source === "named-artifact") return row.type === "file_transition" && row.transitionId === evidence.transitionId
		if (row.type !== "plan") return false
		const matchesPath = [row.path, row.snapshotPath].some((path) => {
			if (typeof path !== "string") return false
			if (path === evidence.path) return true
			try {
				return realpathSync(path) === evidence.path
			} catch {
				return false
			}
		})
		if (!matchesPath) return false
		// The editable plan may have changed since it was produced. Require its retained version.
		try {
			if (typeof row.snapshotPath !== "string" || typeof row.contentHash !== "string") return false
			const saved = readFileSync(row.snapshotPath)
			return (
				createHash("sha256").update(saved).digest("hex") === row.contentHash &&
				saved.equals(readFileSync(evidence.path))
			)
		} catch {
			return false
		}
	})
	if (!producers.length || !producers.every((row) => isWorkId(row.requestId))) return
	const producerIds = new Set(producers.map((row) => row.requestId))
	if (producerIds.size !== 1) return
	const origins = records.filter((row) => row.type === "request" && producerIds.has(row.requestId))
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
	const requests = records.filter(
		(row) =>
			row.type === "request" && row.workId === workId && isWorkSegment(row.segment) && row.segment.id === segment.id,
	)
	if (!requests.every((row) => isWorkId(row.requestId) && isWorkScope(row.scope) && sameWorkScope(row.scope, scope)))
		return
	const requestIds = [...new Set(requests.map((row) => String(row.requestId)))].sort()
	if (
		records.some(
			(row) =>
				row.type === "work_link" &&
				Array.isArray(row.requestIds) &&
				row.requestIds.some((id) => requestIds.includes(id)),
		)
	)
		return
	appendWorkRecord(ctx, {
		type: "work_link",
		linkId: randomUUID(),
		revision: 1,
		status: "active",
		sourceWorkId: workId,
		targetWorkId: workId,
		requestIds,
		scope,
		evidence: { ...evidence, source, requestId: origins[0].requestId, segmentId: segment.id },
	})
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
	let existing = records.filter(
		(row) => row.type === "work_link" && row.targetWorkId === targetWorkId && row.linkId === id,
	)
	let requestIds: string[]
	let sourceWorkId: string
	if (command === "link") {
		const sourceScope = readWorkScope(id)
		const selected = records.filter(
			(row) =>
				row.type === "request" &&
				row.workId === id &&
				!!row.segment &&
				typeof row.segment === "object" &&
				"id" in row.segment &&
				row.segment.id === segmentId,
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
	} else {
		const previous = existing[0]
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
			evidence: command === "link" ? { source: "work-command", segmentId } : existing[0].evidence,
		})
	}
	return `Work correction ${command === "link" ? "saved" : "revoked"}: ${linkIds.join(", ")}. Original request IDs are unchanged.`
}
