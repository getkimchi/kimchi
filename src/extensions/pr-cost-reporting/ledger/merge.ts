import { mergePullRequestLinks } from "../../pull-request-status/links.js"
import { type Collection, ROW_KEYS } from "../../work-attribution/row-log.js"
import type { WorkRecord } from "../../work-attribution/summary.js"

/**
 * Storage-agnostic merge core shared by capture and import. Extracted from summary.ts so the ledger can fold
 * records inside a synchronous transaction; summary.ts keeps its own predicate copy to avoid a module cycle.
 */
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Empty or failed lookups never remove an association already confirmed by GitHub. */
function pullRequestLinks(...values: unknown[]): Record<string, unknown>[] {
	return mergePullRequestLinks(...values.map((value) => (Array.isArray(value) ? value.filter(isObject) : [])))
}

/** Whole-file evidence takes precedence over a match of surviving native hunks. */
export function fileMatchStrength(method: unknown): number {
	if (method === "file-chain") return 3
	if (method === "path-blob") return 2
	return method === "file-hunks" ? 1 : 0
}

/** A repeated scan can add evidence or strengthen a match without discarding earlier links. */
function fileMatches(...values: unknown[]) {
	const matches = new Map<
		string,
		{ path: string; method: "file-chain" | "path-blob" | "file-hunks"; transitionIds: string[]; worktree: string }
	>()
	for (const value of values) {
		if (!Array.isArray(value)) continue
		for (const item of value) {
			if (
				!isObject(item) ||
				typeof item.path !== "string" ||
				typeof item.worktree !== "string" ||
				(item.method !== "file-chain" && item.method !== "path-blob" && item.method !== "file-hunks")
			)
				continue
			const key = JSON.stringify([item.path, item.worktree])
			const existing = matches.get(key)
			if (fileMatchStrength(existing?.method) > fileMatchStrength(item.method)) continue
			matches.set(key, {
				path: item.path,
				worktree: item.worktree,
				method: item.method,
				transitionIds: strings(existing?.method === item.method ? existing.transitionIds : [], item.transitionIds),
			})
		}
	}
	return [...matches.values()]
}

function strings(...values: unknown[]): string[] {
	return [
		...new Set(
			values.flatMap((value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : [])),
		),
	]
}

function latestObservation(previous: unknown, current: unknown): Record<string, unknown> | undefined {
	if (!isObject(current) || typeof current.checkedAt !== "string" || !Number.isFinite(Date.parse(current.checkedAt)))
		return isObject(previous) ? previous : undefined
	if (!isObject(previous) || typeof previous.checkedAt !== "string" || !Number.isFinite(Date.parse(previous.checkedAt)))
		return current
	return Date.parse(current.checkedAt) >= Date.parse(previous.checkedAt) ? current : previous
}

function billingRowKey(row: unknown): string {
	return isObject(row) && typeof row.id === "string" ? row.id : JSON.stringify(row)
}

/** The summary collection each record type merges into. */
export const RECORD_COLLECTIONS: Record<Exclude<WorkRecord["type"], "work">, Collection> = {
	work_link: "workLinks",
	request: "requests",
	request_dispatch: "requests",
	request_response: "requests",
	request_cost: "requests",
	plan: "plans",
	commit: "commits",
	file_transition: "fileTransitions",
	file_observation: "fileObservations",
}

/** Rows by key. A store that reads saved rows on demand can stand in for a Map. */
interface RowMap {
	get(key: string): Record<string, unknown> | undefined
	has(key: string): boolean
	set(key: string, row: Record<string, unknown>): unknown
}

/** One work's rows while records merge: sessions in first-seen order, each collection by row key. */
export type SummaryRows = { sessions: { add(sessionId: string): unknown } } & Record<Collection, RowMap>

const continuationKey = ROW_KEYS.continuations

/**
 * Merge rules for one batch of records, applied row by row. Synchronous on purpose: capture and import commit the
 * fold inside one transaction, and imports are bounded per pass by their callers.
 */
export function mergeRecordsInto(summary: SummaryRows, records: WorkRecord[]): void {
	const { sessions, continuations } = summary
	for (const record of records) {
		const { type, version: _version, workId: _workId, ...item } = record
		sessions.add(item.sessionId)
		if (type === "work") {
			if (
				isObject(item.continuation) &&
				typeof item.continuation.source === "string" &&
				isObject(item.continuation.evidence)
			) {
				const row = {
					sessionId: item.sessionId,
					cwd: item.cwd,
					recordedAt: item.recordedAt,
					source: item.continuation.source,
					evidence: item.continuation.evidence,
				}
				const key = continuationKey(row)
				if (!continuations.has(key)) continuations.set(key, row)
			}
			continue
		}
		const collection = RECORD_COLLECTIONS[type]
		if (!collection) continue
		const entries = summary[collection]
		const key = ROW_KEYS[collection](item)
		const existing = entries.get(key)
		if (type === "request_cost" && existing?.billingRows !== undefined && Array.isArray(item.billingRows)) {
			// Each billing ID is listed once, as its latest observation describes it.
			const newer = latestObservation(existing.billingLookup, item.billingLookup) === item.billingLookup
			const rows = new Map<string, unknown>()
			for (const row of Array.isArray(existing.billingRows) ? existing.billingRows : [])
				rows.set(billingRowKey(row), row)
			for (const row of item.billingRows) if (newer || !rows.has(billingRowKey(row))) rows.set(billingRowKey(row), row)
			item.billingRows = [...rows.values()]
		}
		if (type === "request_cost" && (item.billingLookup !== undefined || existing?.billingLookup !== undefined))
			item.billingLookup = latestObservation(existing?.billingLookup, item.billingLookup)
		if (type === "commit" && (item.fileMatches !== undefined || existing?.fileMatches !== undefined))
			item.fileMatches = fileMatches(existing?.fileMatches, item.fileMatches)
		if (type === "commit") {
			if (item.pullRequests !== undefined || existing?.pullRequests !== undefined)
				item.pullRequests = pullRequestLinks(existing?.pullRequests, item.pullRequests)
			if (item.prLookup !== undefined || existing?.prLookup !== undefined)
				item.prLookup = latestObservation(existing?.prLookup, item.prLookup)
		}
		if (existing) {
			const paths = type === "commit" ? strings(existing.paths, item.paths) : []
			const transitionIds = type === "commit" ? strings(existing.transitionIds, item.transitionIds) : []
			Object.assign(existing, item)
			if (paths.length) existing.paths = paths
			if (transitionIds.length) existing.transitionIds = transitionIds
			// Storage backends hand back detached copies; write the merged row back (first-seen position is preserved).
			entries.set(key, existing)
		} else entries.set(key, item)
	}
}
