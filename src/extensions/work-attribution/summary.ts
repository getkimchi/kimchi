import { randomUUID } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { lock } from "proper-lockfile"
import { isWorkId } from "../../shared/work-id.js"

const LOCK_STALE_MS = 5000
const MERGE_BATCH_SIZE = 1000
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
async function readSummary(path: string, workId: string): Promise<WorkSummary | undefined> {
	try {
		const value = JSON.parse(await readFile(path, "utf8"))
		if (validSummary(value, workId)) return value
	} catch (error) {
		if (!(error instanceof SyntaxError) && (!object(error) || error.code !== "ENOENT")) throw error
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
function planKey(row: SummaryEntry): string {
	return JSON.stringify([row.sessionId, row.path])
}
function commitKey(row: SummaryEntry): string {
	return JSON.stringify([row.sessionId, row.sha, row.repository, row.worktree])
}
async function merge(summary: WorkSummary, records: WorkRecord[]): Promise<void> {
	const sessions = new Set(summary.sessions)
	const requests = new Map(summary.requests.map((row) => [JSON.stringify(row.requestId), row]))
	const plans = new Map(summary.plans.map((row) => [planKey(row), row]))
	const commits = new Map(summary.commits.map((row) => [commitKey(row), row]))
	for (let index = 0; index < records.length; index++) {
		if (index % MERGE_BATCH_SIZE === 0) await setImmediate()
		const { type, version: _version, workId: _workId, ...item } = records[index]
		sessions.add(item.sessionId)
		if (type === "work") continue
		const entries = type === "request" ? requests : type === "plan" ? plans : commits
		const key = type === "request" ? JSON.stringify(item.requestId) : type === "plan" ? planKey(item) : commitKey(item)
		const existing = entries.get(key)
		if (existing) {
			const paths = type === "commit" ? strings(existing.paths, item.paths) : []
			const transitionIds = type === "commit" ? strings(existing.transitionIds, item.transitionIds) : []
			Object.assign(existing, item)
			if (paths.length) existing.paths = paths
			if (transitionIds.length) existing.transitionIds = transitionIds
		} else entries.set(key, item)
	}
	summary.sessions = [...sessions]
	summary.requests = [...requests.values()]
	summary.plans = [...plans.values()]
	summary.commits = [...commits.values()]
}
async function publish(directory: string, summary: WorkSummary, assertLease: () => void): Promise<void> {
	const temporary = join(directory, `.work-${randomUUID()}.tmp`)
	try {
		const file = await open(temporary, "wx", 0o600)
		try {
			await file.writeFile(`${JSON.stringify(summary, null, 2)}\n`)
			await file.sync()
		} finally {
			await file.close()
		}
		assertLease()
		await rename(temporary, join(directory, "work.json"))
	} finally {
		await rm(temporary, { force: true })
	}
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
	const value = summary ?? { version: 1, workId, sessions: [], requests: [], plans: [], commits: [] }
	const history = !summary && !complete ? readRecords(agentDir).filter((row) => row.workId === workId) : []
	await merge(value, history.concat(records))
	assertLease()
	await publish(directory, value, assertLease)
}
function refresh(agentDir: string, workId: string, records: WorkRecord[], complete = false): void {
	const directory = join(agentDir, "work", workId)
	const queued = pending.get(directory)
	if (queued) {
		queued.records = queued.records.concat(records)
		queued.complete ||= complete
		return
	}
	const queue: PendingUpdate = { records: [...records], complete, promise: Promise.resolve() }
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
	})().catch(warn)
	pending.set(directory, queue)
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
/** Shutdown awaits queued contention retries; every retry has a finite deadline. */
export async function flushWorkSummaries(): Promise<void> {
	while (pending.size) await Promise.all([...pending.values()].map((update) => update.promise))
}
