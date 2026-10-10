import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { lock } from "proper-lockfile"
import { writeFileDurably } from "../../config/json.js"
import { isWorkId } from "../../shared/work-id.js"
import { mergePullRequestLinks } from "../pull-request-status/links.js"
import { debugWorkAttribution } from "./diagnostics.js"

const LOCK_STALE_MS = 5000
const MERGE_BATCH_SIZE = 1000
const LOCK_RETRIES = { retries: 60, factor: 1.5, minTimeout: 25, maxTimeout: 100 }
const RECOVERY_STAMP = ".recovered.json"
const RECOVERY_VERSION = 3
// Coarse filesystem timestamps and small clock differences must not hide an append.
const RECOVERY_MTIME_SLACK_MS = 2000
interface SummaryEntry {
	sessionId: string
	[key: string]: unknown
}
export interface WorkRecord extends SummaryEntry {
	version: 1
	type: "work" | "work_link" | "request" | "plan" | "commit" | "file_transition"
	workId: string
}
interface WorkSummary {
	version: 1
	workId: string
	sessions: string[]
	workLinks: SummaryEntry[]
	requests: SummaryEntry[]
	plans: SummaryEntry[]
	commits: SummaryEntry[]
	fileTransitions: SummaryEntry[]
	continuations: SummaryEntry[]
}
interface PendingUpdate {
	records: WorkRecord[]
	complete: boolean
	/** Resolves false when the update failed and its records still need recovery. */
	promise: Promise<boolean>
}
const pending = new Map<string, PendingUpdate>()
const backgroundTasks = new Set<Promise<unknown>>()
const recoveredDirectories = new Set<string>()
/** Work IDs generated in this process: they cannot have older history to scan. */
const newWork = new Set<string>()
function logDebug(error: unknown): void {
	debugWorkAttribution("Work summary unavailable:", error)
}
export function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}
function entry(value: unknown, fields: string[]): value is SummaryEntry {
	return (
		object(value) && typeof value.sessionId === "string" && fields.every((field) => typeof value[field] === "string")
	)
}
function record(value: unknown): value is WorkRecord {
	if (!object(value) || value.version !== 1 || !isWorkId(value.workId) || typeof value.sessionId !== "string")
		return false
	switch (value.type) {
		case "work":
			return true
		case "work_link":
			return entry(value, ["linkId", "sourceWorkId", "targetWorkId"]) && Array.isArray(value.requestIds)
		case "request":
			return entry(value, ["requestId"])
		case "plan":
			return entry(value, ["path"])
		case "commit":
			return entry(value, ["sha", "repository", "worktree"])
		case "file_transition":
			return entry(value, ["transitionId", "toolCallId", "repository", "worktree", "path"])
		default:
			return false
	}
}
function validSummary(value: unknown, workId: string): value is WorkSummary {
	return (
		object(value) &&
		value.version === 1 &&
		value.workId === workId &&
		(value.workLinks === undefined ||
			(Array.isArray(value.workLinks) &&
				value.workLinks.every((row) => entry(row, ["linkId", "sourceWorkId", "targetWorkId"])))) &&
		Array.isArray(value.sessions) &&
		value.sessions.every((session) => typeof session === "string") &&
		Array.isArray(value.requests) &&
		value.requests.every((row) => entry(row, ["requestId"])) &&
		Array.isArray(value.plans) &&
		value.plans.every((row) => entry(row, ["path"])) &&
		Array.isArray(value.commits) &&
		value.commits.every((row) => entry(row, ["sha", "repository", "worktree"])) &&
		(value.fileTransitions === undefined ||
			(Array.isArray(value.fileTransitions) &&
				value.fileTransitions.every((row) =>
					entry(row, ["transitionId", "toolCallId", "repository", "worktree", "path"]),
				))) &&
		(value.continuations === undefined ||
			(Array.isArray(value.continuations) &&
				value.continuations.every((row) => entry(row, ["source"]) && object(row.evidence))))
	)
}
async function readSummary(path: string, workId: string): Promise<WorkSummary | undefined> {
	try {
		const value = JSON.parse(await readFile(path, "utf8"))
		if (validSummary(value, workId))
			return {
				...value,
				workLinks: value.workLinks ?? [],
				fileTransitions: value.fileTransitions ?? [],
				continuations: value.continuations ?? [],
			}
	} catch (error) {
		if (!(error instanceof SyntaxError) && (!object(error) || error.code !== "ENOENT")) throw error
	}
}
export function readWorkRecords(agentDir: string, modifiedSince?: number): WorkRecord[] {
	const directory = join(agentDir, "work-attribution")
	if (!existsSync(directory)) return []
	const records: WorkRecord[] = []
	// Both kinds of source journals feed work.json; there is no second copy of file evidence.
	for (const source of [directory, join(directory, "transitions")]) {
		if (!existsSync(source)) continue
		for (const file of readdirSync(source, { withFileTypes: true })) {
			if (!file.isFile() || !file.name.endsWith(".jsonl")) continue
			try {
				const path = join(source, file.name)
				if (modifiedSince !== undefined && statSync(path).mtimeMs < modifiedSince) continue
				for (const line of readFileSync(path, "utf8").split("\n")) {
					try {
						const value = JSON.parse(line)
						if (record(value)) records.push(value)
					} catch {
						/* interrupted append */
					}
				}
			} catch (error) {
				// An incomplete scan must not advance recovery past a journal we could not read.
				throw new Error(`Could not read work ledger ${file.name}`, { cause: error })
			}
		}
	}
	return records
}
function strings(...values: unknown[]): string[] {
	return [
		...new Set(
			values.flatMap((value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : [])),
		),
	]
}
function planKey(row: SummaryEntry): string {
	return JSON.stringify([row.sessionId, row.path, row.snapshotPath])
}
function commitKey(row: SummaryEntry): string {
	return JSON.stringify([row.sessionId, row.sha, row.repository, row.worktree])
}
function continuationKey(row: SummaryEntry): string {
	return JSON.stringify([row.sessionId, row.source, row.evidence])
}
function latestObservation(previous: unknown, current: unknown): Record<string, unknown> | undefined {
	if (!object(current) || typeof current.checkedAt !== "string") return object(previous) ? previous : undefined
	if (!object(previous) || typeof previous.checkedAt !== "string") return current
	return Date.parse(current.checkedAt) >= Date.parse(previous.checkedAt) ? current : previous
}
/** Empty or failed lookups never remove an association already confirmed by GitHub. */
function pullRequestLinks(...values: unknown[]): Record<string, unknown>[] {
	return mergePullRequestLinks(...values.map((value) => (Array.isArray(value) ? value.filter(object) : [])))
}
/** A repeated scan can add evidence or strengthen a match without discarding earlier links. */
function fileMatches(...values: unknown[]) {
	const matches = new Map<
		string,
		{ path: string; method: "file-chain" | "path-blob"; transitionIds: string[]; worktree: string }
	>()
	for (const value of values) {
		if (!Array.isArray(value)) continue
		for (const item of value) {
			if (
				!object(item) ||
				typeof item.path !== "string" ||
				typeof item.worktree !== "string" ||
				(item.method !== "file-chain" && item.method !== "path-blob")
			)
				continue
			const key = JSON.stringify([item.path, item.worktree])
			const existing = matches.get(key)
			if (existing?.method === "file-chain" && item.method === "path-blob") continue
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
function recordKey(type: WorkRecord["type"], row: SummaryEntry): string {
	switch (type) {
		case "work_link":
			return JSON.stringify([
				row.linkId,
				row.revision,
				row.sourceWorkId,
				row.targetWorkId,
				row.requestIds,
				row.scope,
				row.status,
				row.evidence,
			])
		case "request":
			return JSON.stringify(row.requestId)
		case "plan":
			return planKey(row)
		case "commit":
			return commitKey(row)
		default:
			return JSON.stringify(row.transitionId)
	}
}
async function merge(summary: WorkSummary, records: WorkRecord[]): Promise<void> {
	const sessions = new Set(summary.sessions)
	const links = new Map(summary.workLinks.map((row) => [recordKey("work_link", row), row]))
	const requests = new Map(summary.requests.map((row) => [JSON.stringify(row.requestId), row]))
	const plans = new Map(summary.plans.map((row) => [planKey(row), row]))
	const commits = new Map(summary.commits.map((row) => [commitKey(row), row]))
	const transitions = new Map(summary.fileTransitions.map((row) => [JSON.stringify(row.transitionId), row]))
	const continuations = new Map(summary.continuations.map((row) => [continuationKey(row), row]))
	const entriesByType = {
		work_link: links,
		request: requests,
		plan: plans,
		commit: commits,
		file_transition: transitions,
	}
	for (let index = 0; index < records.length; index++) {
		if (index % MERGE_BATCH_SIZE === 0) await setImmediate()
		const { type, version: _version, workId: _workId, ...item } = records[index]
		sessions.add(item.sessionId)
		if (type === "work") {
			if (
				object(item.continuation) &&
				typeof item.continuation.source === "string" &&
				object(item.continuation.evidence)
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
		const entries = entriesByType[type]
		const key = recordKey(type, item)
		const existing = entries.get(key)
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
		} else entries.set(key, item)
	}
	summary.sessions = [...sessions]
	summary.workLinks = [...links.values()]
	summary.requests = [...requests.values()]
	summary.plans = [...plans.values()]
	summary.commits = [...commits.values()]
	summary.fileTransitions = [...transitions.values()]
	summary.continuations = [...continuations.values()]
}
function publish(directory: string, summary: WorkSummary, assertLease: () => void): Promise<void> {
	return writeFileDurably(join(directory, "work.json"), `${JSON.stringify(summary, null, 2)}\n`, assertLease)
}
async function update(
	agentDir: string,
	workId: string,
	records: WorkRecord[],
	complete: boolean,
	assertLease: () => void,
): Promise<void> {
	assertLease()
	const directory = join(agentDir, "work", workId)
	const summary = await readSummary(join(directory, "work.json"), workId)
	const published = summary && JSON.stringify(summary)
	const value = summary ?? {
		version: 1,
		workId,
		sessions: [],
		workLinks: [],
		requests: [],
		plans: [],
		commits: [],
		fileTransitions: [],
		continuations: [],
	}
	const history = !summary && !complete ? readWorkRecords(agentDir).filter((row) => row.workId === workId) : []
	await merge(value, history.concat(records))
	if (published === JSON.stringify(value)) return
	assertLease()
	await publish(directory, value, assertLease)
}
function refresh(agentDir: string, workId: string, records: WorkRecord[], complete = false): Promise<boolean> {
	const directory = join(agentDir, "work", workId)
	// A work ID generated here has no earlier records, so its first write skips the history scan.
	if (newWork.delete(workId)) complete = true
	const queued = pending.get(directory)
	if (queued) {
		queued.records = queued.records.concat(records)
		queued.complete ||= complete
		return queued.promise
	}
	const queue: PendingUpdate = { records: [...records], complete, promise: Promise.resolve(true) }
	queue.promise = (async () => {
		try {
			await mkdir(directory, { recursive: true, mode: 0o700 })
			while (queue.records.length) {
				let compromised: Error | undefined
				const release = await lock(directory, {
					stale: LOCK_STALE_MS,
					retries: LOCK_RETRIES,
					onCompromised: (error) => {
						compromised = error
					},
				})
				const assertLease = () => {
					if (compromised) throw compromised
				}
				try {
					const batch = queue.records.splice(0)
					const completeBatch = queue.complete
					queue.complete = false
					await update(agentDir, workId, batch, completeBatch, assertLease)
				} finally {
					// A compromised lease has already been removed from proper-lockfile's ownership map.
					if (!compromised) await release()
				}
			}
		} finally {
			pending.delete(directory)
		}
	})().then(
		() => true,
		(error: unknown) => {
			logDebug(error)
			return false
		},
	)
	pending.set(directory, queue)
	return queue.promise
}
/** Call before the first record of a freshly generated work ID. */
export function markNewWork(workId: string): void {
	newWork.add(workId)
}
/** Called only after the source record has been durably appended. */
export function updateWorkSummary(value: unknown): void {
	if (record(value)) refresh(getAgentDir(), value.workId, [value])
}
function summaryFingerprint(path: string): string {
	const { size, mtimeMs } = statSync(path)
	return `${size}:${mtimeMs}`
}
async function readRecovery(agentDir: string, stamp: string) {
	let saved: unknown
	try {
		saved = JSON.parse(readFileSync(stamp, "utf8"))
	} catch {
		return undefined
	}
	if (
		!object(saved) ||
		saved.version !== RECOVERY_VERSION ||
		typeof saved.startedAt !== "number" ||
		!Number.isFinite(saved.startedAt) ||
		saved.startedAt > Date.now() ||
		!object(saved.summaries)
	)
		return undefined
	const summaries: Record<string, string> = {}
	for (const [workId, fingerprint] of Object.entries(saved.summaries)) {
		if (!isWorkId(workId) || typeof fingerprint !== "string") return undefined
		const path = join(agentDir, "work", workId, "work.json")
		if (!existsSync(path)) return undefined
		const current = summaryFingerprint(path)
		// Missing or damaged output requires all source ledgers, even when none changed.
		if (current !== fingerprint && !(await readSummary(path, workId))) return undefined
		summaries[workId] = current
	}
	return { startedAt: saved.startedAt, summaries }
}
/**
 * One launch-time pass heals records left behind by an interrupted summary update.
 * Records written before the last fully successful pass started were already published by it,
 * so only ledgers modified since then are replayed. Delete the stamp to force a full replay.
 */
export function recoverWorkSummaries(): void {
	const agentDir = getAgentDir()
	if (recoveredDirectories.has(agentDir)) return
	recoveredDirectories.add(agentDir)
	trackAttributionTask(
		recover(agentDir).catch((error) => {
			recoveredDirectories.delete(agentDir)
			logDebug(error)
		}),
	)
}
async function recover(agentDir: string): Promise<void> {
	const stamp = join(agentDir, "work-attribution", RECOVERY_STAMP)
	const startedAt = Date.now()
	const previous = await readRecovery(agentDir, stamp)
	const groups = new Map<string, WorkRecord[]>()
	for (const row of readWorkRecords(agentDir, previous && previous.startedAt - RECOVERY_MTIME_SLACK_MS)) {
		const rows = groups.get(row.workId) ?? []
		rows.push(row)
		groups.set(row.workId, rows)
	}
	const updates = [...groups].map(([workId, rows]) => refresh(agentDir, workId, rows, !previous))
	if (!(await Promise.all(updates)).every(Boolean) || !existsSync(dirname(stamp))) return
	const summaries = previous?.summaries ?? {}
	for (const workId of groups.keys())
		summaries[workId] = summaryFingerprint(join(agentDir, "work", workId, "work.json"))
	writeFileSync(stamp, JSON.stringify({ version: RECOVERY_VERSION, startedAt, summaries }), { mode: 0o600 })
}
/** Shared summary recovery that shutdown and tests must drain. */
function trackAttributionTask(task: Promise<unknown>): void {
	const tracked = task.finally(() => backgroundTasks.delete(tracked))
	backgroundTasks.add(tracked)
}
/** Shutdown awaits queued contention retries and background tasks; each has a finite deadline. */
export async function flushWorkSummaries(): Promise<void> {
	while (pending.size || backgroundTasks.size)
		await Promise.all([...[...pending.values()].map((update) => update.promise), ...backgroundTasks])
}
