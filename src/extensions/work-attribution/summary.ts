import { randomUUID } from "node:crypto"
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { lock, lockSync } from "proper-lockfile"
import { isWorkId } from "../../shared/work-id.js"

const LOCK_STALE_MS = 5000
const LOCK_RETRIES = { retries: 60, factor: 1.5, minTimeout: 25, maxTimeout: 100 }
interface SummaryEntry {
	sessionId: string
	[key: string]: unknown
}
interface WorkRecord extends SummaryEntry {
	version: 1
	type: "work" | "request" | "plan" | "commit"
	workId: string
}
interface WorkSummary {
	version: 1
	workId: string
	sessions: string[]
	requests: SummaryEntry[]
	plans: SummaryEntry[]
	commits: SummaryEntry[]
}
interface PendingUpdate {
	records: WorkRecord[]
	complete: boolean
	promise: Promise<void>
}
const pending = new Map<string, PendingUpdate>()
const recoveredDirectories = new Set<string>()
function warn(error: unknown): void {
	console.warn("[work-attribution] Work summary unavailable:", error)
}
function object(value: unknown): value is Record<string, unknown> {
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
		case "request":
			return entry(value, ["requestId"])
		case "plan":
			return entry(value, ["path"])
		case "commit":
			return entry(value, ["sha", "repository", "worktree"])
		default:
			return false
	}
}
function validSummary(value: unknown, workId: string): value is WorkSummary {
	return (
		object(value) &&
		value.version === 1 &&
		value.workId === workId &&
		Array.isArray(value.sessions) &&
		value.sessions.every((session) => typeof session === "string") &&
		Array.isArray(value.requests) &&
		value.requests.every((row) => entry(row, ["requestId"])) &&
		Array.isArray(value.plans) &&
		value.plans.every((row) => entry(row, ["path"])) &&
		Array.isArray(value.commits) &&
		value.commits.every((row) => entry(row, ["sha", "repository", "worktree"]))
	)
}
function readSummary(path: string, workId: string): WorkSummary | undefined {
	if (!existsSync(path)) return
	try {
		const value = JSON.parse(readFileSync(path, "utf8"))
		if (validSummary(value, workId)) return value
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error
	}
}
function readRecords(agentDir: string): WorkRecord[] {
	const directory = join(agentDir, "work-attribution")
	if (!existsSync(directory)) return []
	const records: WorkRecord[] = []
	// Only original session ledgers: native file-transition journals are evidence for later matching.
	for (const file of readdirSync(directory, { withFileTypes: true })) {
		if (!file.isFile() || !file.name.endsWith(".jsonl")) continue
		try {
			for (const line of readFileSync(join(directory, file.name), "utf8").split("\n")) {
				try {
					const value = JSON.parse(line)
					if (record(value)) records.push(value)
				} catch {
					/* interrupted append */
				}
			}
		} catch (error) {
			warn(error)
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
function merge(summary: WorkSummary, record: WorkRecord): void {
	if (!summary.sessions.includes(record.sessionId)) summary.sessions.push(record.sessionId)
	const { type, version: _version, workId: _workId, ...item } = record
	if (type === "work") return
	if (type === "request") {
		const existing = summary.requests.find((row) => row.requestId === item.requestId)
		if (existing) Object.assign(existing, item)
		else summary.requests.push(item)
	} else if (type === "plan") {
		const existing = summary.plans.find((row) => row.sessionId === item.sessionId && row.path === item.path)
		if (existing) Object.assign(existing, item)
		else summary.plans.push(item)
	} else {
		const existing = summary.commits.find(
			(row) =>
				row.sessionId === item.sessionId &&
				row.sha === item.sha &&
				row.repository === item.repository &&
				row.worktree === item.worktree,
		)
		if (existing) {
			const paths = strings(existing.paths, item.paths)
			const transitionIds = strings(existing.transitionIds, item.transitionIds)
			Object.assign(existing, item)
			if (paths.length) existing.paths = paths
			if (transitionIds.length) existing.transitionIds = transitionIds
		} else summary.commits.push(item)
	}
}
function publish(directory: string, summary: WorkSummary): void {
	const temporary = join(directory, `.work-${randomUUID()}.tmp`)
	try {
		const fd = openSync(temporary, "wx", 0o600)
		try {
			writeFileSync(fd, `${JSON.stringify(summary, null, 2)}\n`)
			fsyncSync(fd)
		} finally {
			closeSync(fd)
		}
		renameSync(temporary, join(directory, "work.json"))
	} finally {
		rmSync(temporary, { force: true })
	}
}
function update(agentDir: string, workId: string, records: WorkRecord[], complete: boolean): void {
	const directory = join(agentDir, "work", workId)
	const summary = readSummary(join(directory, "work.json"), workId)
	const value = summary ?? { version: 1, workId, sessions: [], requests: [], plans: [], commits: [] }
	if (!summary && !complete) for (const row of readRecords(agentDir)) if (row.workId === workId) merge(value, row)
	for (const row of records) merge(value, row)
	publish(directory, value)
}
function refresh(agentDir: string, workId: string, records: WorkRecord[], complete = false): void {
	const directory = join(agentDir, "work", workId)
	try {
		mkdirSync(directory, { recursive: true, mode: 0o700 })
		let release: () => void
		try {
			release = lockSync(directory, { stale: LOCK_STALE_MS })
		} catch (error) {
			if (!object(error) || error.code !== "ELOCKED") throw error
			// Never wait for another process on the provider dispatch path.
			const queued = pending.get(directory)
			if (queued) {
				queued.records.push(...records)
				queued.complete ||= complete
				return
			}
			const updateQueue: PendingUpdate = { records: [...records], complete, promise: Promise.resolve() }
			updateQueue.promise = (async () => {
				try {
					while (updateQueue.records.length) {
						const release = await lock(directory, { stale: LOCK_STALE_MS, retries: LOCK_RETRIES })
						try {
							const batch = updateQueue.records.splice(0)
							const completeBatch = updateQueue.complete
							updateQueue.complete = false
							update(agentDir, workId, batch, completeBatch)
						} finally {
							await release()
						}
					}
				} finally {
					pending.delete(directory)
				}
			})().catch(warn)
			pending.set(directory, updateQueue)
			return
		}
		try {
			update(agentDir, workId, records, complete)
		} finally {
			release()
		}
	} catch (error) {
		warn(error)
	}
}
/** Called only after the source record has been durably appended. */
export function updateWorkSummary(value: unknown): void {
	if (record(value)) refresh(getAgentDir(), value.workId, [value])
}
/** One launch-time pass also heals records left behind by an interrupted summary update. */
export function recoverWorkSummaries(): void {
	try {
		const agentDir = getAgentDir()
		if (recoveredDirectories.has(agentDir)) return
		const groups = new Map<string, WorkRecord[]>()
		for (const row of readRecords(agentDir)) {
			const rows = groups.get(row.workId) ?? []
			rows.push(row)
			groups.set(row.workId, rows)
		}
		for (const [workId, rows] of groups) refresh(agentDir, workId, rows, true)
		recoveredDirectories.add(agentDir)
	} catch (error) {
		warn(error)
	}
}
/** Idle/shutdown awaits queued contention retries; every retry has a finite deadline. */
export async function flushWorkSummaries(): Promise<void> {
	while (pending.size) await Promise.all([...pending.values()].map((update) => update.promise))
}
