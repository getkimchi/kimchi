import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFile, rm } from "node:fs/promises"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
// Inherited-marker scans are primary; polling is only a low-rate secondary net.
const PROCESS_POLL_MS = 250
const PROCESS_SETTLE_MS = 25
export const REVIEW_PREPARATION_ID_ENV = "KIMCHI_REVIEW_PREPARATION_ID"

export class PreparationContainmentError extends Error {
	constructor(note: string) {
		super(note)
		this.name = "PreparationContainmentError"
	}
}

interface ProcessEntry {
	pid: number
	ppid: number
	pgid: number
	state: string
}

interface PreparationSnapshot {
	entries: ProcessEntry[]
	candidateIds: Set<number>
	complete: boolean
}

async function delay(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms))
}

async function processTable(): Promise<ProcessEntry[]> {
	const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat="], {
		timeout: 5_000,
		windowsHide: true,
		maxBuffer: 16 * 1024 * 1024,
	})
	const entries: ProcessEntry[] = []
	for (const line of stdout.trim().split("\n")) {
		const [pidText, ppidText, pgidText, state = ""] = line.trim().split(/\s+/)
		const [pid, ppid, pgid] = [pidText, ppidText, pgidText].map(Number)
		if (Number.isSafeInteger(pid) && Number.isSafeInteger(ppid) && Number.isSafeInteger(pgid)) {
			entries.push({ pid, ppid, pgid, state })
		}
	}
	return entries
}

/** `ps -o command` omits environments on macOS. The default eww listing works
 * on both macOS and Linux; output stays in memory and is never logged. */
async function markedProcessIds(preparationId: string): Promise<Set<number>> {
	const { stdout } = await execFileAsync("ps", ["eww", "-A"], {
		timeout: 5_000,
		windowsHide: true,
		maxBuffer: 16 * 1024 * 1024,
	})
	const marker = `${REVIEW_PREPARATION_ID_ENV}=${preparationId}`
	const result = new Set<number>()
	for (const line of stdout.split("\n")) {
		if (!line.includes(marker)) continue
		const pid = Number(/^\s*(\d+)\s/.exec(line)?.[1])
		if (Number.isSafeInteger(pid) && pid > 0) result.add(pid)
	}
	return result
}

function descendants(entries: readonly ProcessEntry[], rootPid: number): ProcessEntry[] {
	const children = new Map<number, number[]>()
	const byPid = new Map<number, ProcessEntry>()
	for (const entry of entries) {
		const siblings = children.get(entry.ppid) ?? []
		siblings.push(entry.pid)
		children.set(entry.ppid, siblings)
		byPid.set(entry.pid, entry)
	}
	const root = byPid.get(rootPid)
	const result: ProcessEntry[] = root ? [root] : []
	const visited = new Set([rootPid])
	const pending = [rootPid]
	for (let index = 0; index < pending.length; index++) {
		for (const child of children.get(pending[index]) ?? []) {
			if (visited.has(child)) continue
			visited.add(child)
			const entry = byPid.get(child)
			if (entry) result.push(entry)
			pending.push(child)
		}
	}
	return result.reverse()
}

function signal(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal)
	} catch {
		// Exit and permission races are settled by the final live-process scan.
	}
}

async function preparationSnapshot(rootPid: number | undefined, preparationId: string): Promise<PreparationSnapshot> {
	const [table, marked] = await Promise.allSettled([processTable(), markedProcessIds(preparationId)])
	const entries = table.status === "fulfilled" ? table.value : []
	const candidateIds = marked.status === "fulfilled" ? marked.value : new Set<number>()
	if (rootPid !== undefined && table.status === "fulfilled") {
		for (const entry of descendants(entries, rootPid)) candidateIds.add(entry.pid)
	}
	return { entries, candidateIds, complete: table.status === "fulfilled" && marked.status === "fulfilled" }
}

/** Combine live descendant tracking with an inherited random marker. The
 * latter finds detached/reparented children even after the original root exits. */
async function terminateDescendants(
	rootPid: number | undefined,
	preparationId: string,
	trackedIds: ReadonlySet<number>,
): Promise<void> {
	const before = await preparationSnapshot(rootPid, preparationId)
	const candidates = new Set([...trackedIds, ...before.candidateIds])
	for (const pid of candidates) signal(pid, "SIGTERM")
	await delay(PROCESS_SETTLE_MS)
	const during = await preparationSnapshot(rootPid, preparationId)
	for (const pid of during.candidateIds) candidates.add(pid)
	for (const pid of candidates) signal(pid, "SIGKILL")
	await delay(PROCESS_SETTLE_MS)
	const after = await preparationSnapshot(rootPid, preparationId)
	for (const pid of after.candidateIds) {
		candidates.add(pid)
		signal(pid, "SIGKILL")
	}
	const remaining = after.entries.filter(
		(entry) => candidates.has(entry.pid) && entry.pid !== process.pid && !entry.state.startsWith("Z"),
	)
	if (!before.complete || !during.complete || !after.complete || remaining.length > 0) {
		throw new PreparationContainmentError(
			"Preparation descendant cleanup could not be verified; the prepared worktree must not be reused.",
		)
	}
}

async function rootPidFromFile(pidFile: string): Promise<number | undefined> {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			const value = Number((await readFile(pidFile, "utf8")).trim())
			return Number.isSafeInteger(value) && value > 0 ? value : undefined
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined
			if (attempt < 4) await delay(10)
		}
	}
	return undefined
}

/** Run one setup/probe command and terminate all of its descendants before
 * returning. Polling retains vanished descendants; final marker scans cover
 * children that reparented before another tree snapshot could observe them. */
export async function withPreparationDescendantCleanup<T>(options: {
	pidFile: string
	signal: AbortSignal
	execute: (execution: { pidFile: string; signal: AbortSignal; preparationId: string }) => Promise<T>
}): Promise<T> {
	const supported = process.platform === "darwin" || process.platform === "linux"
	const preparationId = randomUUID()
	const executionAbort = new AbortController()
	const trackedIds = new Set<number>()
	let rootPid: number | undefined
	let observing = true
	let observationFailed = false
	const observation = (async () => {
		if (!supported) return
		rootPid = await rootPidFromFile(options.pidFile)
		while (observing) {
			try {
				const entries = await processTable()
				if (rootPid !== undefined) {
					for (const entry of descendants(entries, rootPid)) trackedIds.add(entry.pid)
				}
			} catch {
				observationFailed = true
			}
			if (observing) await delay(PROCESS_POLL_MS)
		}
	})()
	let cleanup: Promise<void> | undefined
	const terminate = (): Promise<void> => {
		cleanup ??= (async () => {
			try {
				observing = false
				await observation
				if (!supported) {
					throw new PreparationContainmentError(
						`Preparation descendant containment is unavailable on ${process.platform}; the prepared worktree must not be reused.`,
					)
				}
				await terminateDescendants(rootPid, preparationId, trackedIds)
				if (observationFailed) {
					throw new PreparationContainmentError(
						"Preparation descendant tracking was incomplete; the prepared worktree must not be reused.",
					)
				}
			} finally {
				executionAbort.abort(options.signal.reason)
				await rm(options.pidFile, { force: true }).catch(() => {})
			}
		})()
		return cleanup
	}
	const onAbort = () => {
		void terminate().catch(() => {})
	}
	if (options.signal.aborted) onAbort()
	else options.signal.addEventListener("abort", onAbort, { once: true })
	try {
		return await options.execute({ pidFile: options.pidFile, signal: executionAbort.signal, preparationId })
	} finally {
		await terminate()
		options.signal.removeEventListener("abort", onAbort)
	}
}

export const REVIEW_PREPARATION_PROCESS_TESTING = { descendants }
