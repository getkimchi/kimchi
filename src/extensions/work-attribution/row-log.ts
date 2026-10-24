import { mergePullRequestLinks } from "../pull-request-status/links.js"

/*
 * Pure summary types and helpers. Persistence lives in the ledger (pr-cost-reporting/ledger/records.ts): the
 * work_projection_* tables replace the per-work work.json manifest and row logs, so this module has no file I/O
 * and the old manifest/row-log/compaction machinery is gone.
 */

/** One row of a summary collection. */
export interface Row {
	sessionId: string
	[key: string]: unknown
}

/** Summary collections; each one is a projection log. */
export const COLLECTIONS = [
	"workLinks",
	"requests",
	"plans",
	"commits",
	"fileTransitions",
	"fileObservations",
	"continuations",
] as const
export type Collection = (typeof COLLECTIONS)[number]
/** Every log: the collections and the work's sessions in first-seen order. */
export const LOGS = [...COLLECTIONS, "sessions"] as const
export type LogName = (typeof LOGS)[number]
const LOG_NAMES = new Set<string>(LOGS)

function isLog(name: string): name is LogName {
	return LOG_NAMES.has(name)
}

/** Row identity per log. */
export const ROW_KEYS: Record<LogName, (row: Row) => string> = {
	workLinks: (row) =>
		JSON.stringify([
			row.linkId,
			row.revision,
			row.sourceWorkId,
			row.targetWorkId,
			row.requestIds,
			row.scope,
			row.status,
			row.evidence,
		]),
	requests: (row) => JSON.stringify(row.requestId),
	plans: (row) => JSON.stringify([row.sessionId, row.path, row.snapshotPath]),
	commits: (row) => JSON.stringify([row.sessionId, row.sha, row.repository, row.worktree]),
	fileTransitions: (row) => JSON.stringify(row.transitionId),
	fileObservations: (row) => JSON.stringify(row.observationId),
	continuations: (row) => JSON.stringify([row.sessionId, row.source, row.evidence]),
	sessions: (row) => JSON.stringify(row.sessionId),
}

/** One projection log's shape inside a manifest. */
export interface RowLog {
	generation: number
	/** Committed length. */
	bytes: number
	/** Distinct keys. */
	rows: number
}

/** What `/work` lists. Each value is the newest by its timestamp; later writes win ties. */
export interface WorkLatest {
	/** Newest request start, native edit or retained plan. */
	activityAt?: string
	request?: { startedAt?: string; repository?: string; cwd?: string }
	edit?: { recordedAt?: string; repository: string }
	branch?: { recordedAt?: string; branch: string }
	commit?: { recordedAt?: string; repository: string }
	plan?: { recordedAt?: string; snapshotPath: string }
}

/** Version 2 work manifest, stored in work_projection_head. */
export interface WorkHead {
	version: 2
	workId: string
	/** Time of the last committed change. */
	updatedAt: string
	/** Sessions in first-seen order, in manifests written before the sessions log; the next update moves them. */
	sessions?: string[]
	/** A missing log is an empty collection. */
	logs: Partial<Record<LogName, RowLog>>
	latest: WorkLatest
	/** PR links of every commit row, merged. */
	pullRequests: Record<string, unknown>[]
}

/** Every row of a work, as folding its logs returns them. */
export type WorkSummaryView = { workId: string; sessions: string[] } & Record<Collection, Row[]>

/** Validates one committed row; a failure means the logs are damaged and the work is rebuilt from its records. */
export type RowCheck = (collection: Collection, row: Row) => boolean

/** A projection that does not match its manifest. */
export class RowLogDamage extends Error {}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function count(value: unknown, minimum = 0): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined
}

/** A version 2 manifest for `workId`, checked without opening its logs. */
export function isWorkHead(value: unknown, workId: string): value is WorkHead {
	return (
		object(value) &&
		value.version === 2 &&
		value.workId === workId &&
		typeof value.updatedAt === "string" &&
		(value.sessions === undefined ||
			(Array.isArray(value.sessions) && value.sessions.every((session) => typeof session === "string"))) &&
		object(value.logs) &&
		Object.entries(value.logs).every(
			([name, log]) =>
				isLog(name) && object(log) && count(log.generation, 1) && count(log.rows, 1) && count(log.bytes, log.rows + 1),
		) &&
		object(value.latest) &&
		Array.isArray(value.pullRequests)
	)
}

/** Milliseconds of an ISO 8601 timestamp, as `/work` orders rows; impossible dates are not times. */
function timestamp(value: unknown): number | undefined {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
	)
		return undefined
	const parsed = Date.parse(value)
	if (!Number.isFinite(parsed)) return undefined
	const day = value.slice(0, 10)
	return new Date(`${day}T00:00:00Z`).toISOString().startsWith(day) ? parsed : undefined
}

/** Whether a row stamped `at` replaces a latest value stamped `current`. Rows without a valid time sort first. */
function replaces(at: unknown, current: { at?: string } | undefined): boolean {
	return !current || (timestamp(at) ?? 0) >= (timestamp(current.at) ?? 0)
}

/** Folds one changed or saved row into what `/work` lists. */
export function observeLatest(latest: WorkLatest, collection: Collection, row: Row): void {
	const at = collection === "requests" ? row.startedAt : row.recordedAt
	const time = timestamp(at)
	if (
		time !== undefined &&
		(collection === "requests" || collection === "fileTransitions" || collection === "plans") &&
		time > (timestamp(latest.activityAt) ?? Number.NEGATIVE_INFINITY)
	)
		latest.activityAt = text(at)
	const recordedAt = text(row.recordedAt)
	if (collection === "requests") {
		if (replaces(at, latest.request && { at: latest.request.startedAt })) {
			const scope = object(row.scope) ? row.scope : undefined
			latest.request = { startedAt: text(at), repository: text(scope?.repository), cwd: text(row.cwd) }
		}
	} else if (collection === "fileTransitions") {
		if (typeof row.repository === "string" && replaces(at, latest.edit && { at: latest.edit.recordedAt }))
			latest.edit = { recordedAt, repository: row.repository }
		if (typeof row.branch === "string" && replaces(at, latest.branch && { at: latest.branch.recordedAt }))
			latest.branch = { recordedAt, branch: row.branch }
	} else if (collection === "commits") {
		if (typeof row.repository === "string" && replaces(at, latest.commit && { at: latest.commit.recordedAt }))
			latest.commit = { recordedAt, repository: row.repository }
	} else if (collection === "plans") {
		if (typeof row.snapshotPath === "string" && replaces(at, latest.plan && { at: latest.plan.recordedAt }))
			latest.plan = { recordedAt, snapshotPath: row.snapshotPath }
	}
}

/** PR links of every commit row, merged; empty or failed lookups never remove a link. */
export function commitPullRequests(commits: Iterable<Row>): Record<string, unknown>[] {
	return mergePullRequestLinks(
		...[...commits].map((row) => (Array.isArray(row.pullRequests) ? row.pullRequests.filter(object) : [])),
	)
}

/** `latest` and `pullRequests` recomputed from every row, in log order. */
export function summaryLatest(
	rows: (collection: Collection) => Iterable<Row>,
): Pick<WorkHead, "latest" | "pullRequests"> {
	const latest: WorkLatest = {}
	for (const collection of COLLECTIONS) for (const row of rows(collection)) observeLatest(latest, collection, row)
	return { latest, pullRequests: commitPullRequests(rows("commits")) }
}
