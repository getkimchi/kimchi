import { execFile, execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import {
	type BashOperations,
	createBashToolDefinition,
	createLocalBashOperations,
	getAgentDir,
} from "@earendil-works/pi-coding-agent"

import { appendWorkRecord, getWorkId, pinWorkContext, type WorkContext, workLedgerPath } from "../work-attribution.js"

const MAX_TRACE_BYTES = 8 * 1024 * 1024
const GIT_LOOKUP_TIMEOUT_MS = 2000

export interface ObservedCommit {
	sha: string
	repository: string
	worktree: string
	/** Original commit replayed by a rebase or cherry-pick; the copy is what gets pushed. */
	rewrittenFrom?: string
}
const HEAD_UPDATE = /\b\d+: HEAD [0-9a-f]+ -> ([0-9a-f]{40}|[0-9a-f]{64}) \(/
// Sequencer state names the commit being replayed just before HEAD moves to its copy.
const REPLAYED = /\b\d+: (?:CHERRY_PICK_HEAD|REBASE_HEAD) [0-9a-f]+ -> ([0-9a-f]{40}|[0-9a-f]{64}) \(/
const REWRITE_MESSAGE = /^(?:rebase(?: -i)? \((?:pick|reword|edit|squash|fixup|continue)\)|cherry-pick):/
const execFileAsync = promisify(execFile)
// Bash recreates its operations for each call. Share paths, never the changing replayed SHA.
const replayPathsByCwd = new Map<string, { worktree: string; paths: string[] }>()

/** Git's stopped sequencer state survives a harness restart and disappears on abort. */
async function stoppedReplay(cwd: string): Promise<{ worktree: string; sha: string } | undefined> {
	try {
		let location = replayPathsByCwd.get(cwd)
		if (!location) {
			const env = { ...process.env }
			for (const key of [
				"GIT_DIR",
				"GIT_WORK_TREE",
				"GIT_COMMON_DIR",
				"GIT_INDEX_FILE",
				"GIT_TRACE2_EVENT",
				"GIT_TRACE_REFS",
			])
				delete env[key]
			const { stdout } = await execFileAsync(
				"git",
				[
					"-C",
					cwd,
					"rev-parse",
					"--path-format=absolute",
					"--show-toplevel",
					"--git-path",
					"REBASE_HEAD",
					"--git-path",
					"CHERRY_PICK_HEAD",
				],
				{ encoding: "utf8", env, timeout: GIT_LOOKUP_TIMEOUT_MS },
			)
			const [worktree, ...paths] = stdout.trim().split("\n")
			location = { worktree, paths }
			replayPathsByCwd.set(cwd, location)
		}
		for (const path of location.paths) {
			const sha = readText(path).trim()
			if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) return { worktree: location.worktree, sha }
		}
	} catch {
		// A shell command can run outside a repository.
	}
}

interface GitProcess {
	/** trace2 session ID; a child Git process's ID is prefixed by its parent's. */
	sid: string
	start: number
	end?: number
	command?: string
	worktree?: string
}

function instant(value: string): number {
	// Date parses milliseconds; preserve Git's remaining microseconds.
	return Date.parse(value) * 1000 + Number(/\.(\d{6})Z$/.exec(value)?.[1].slice(3) ?? 0)
}

function processes(trace: string): GitProcess[] {
	const byId = new Map<string, GitProcess>()
	for (const line of trace.split("\n")) {
		if (!line) continue
		const event = JSON.parse(line)
		if (typeof event.sid !== "string" || typeof event.time !== "string") continue
		if (event.event === "start") byId.set(event.sid, { sid: event.sid, start: instant(event.time) })
		const process = byId.get(event.sid)
		if (!process) continue
		if (event.event === "cmd_name") process.command = event.name
		if (event.event === "def_repo") process.worktree = event.worktree
		if (event.event === "exit") process.end = instant(event.time)
	}
	return [...byId.values()]
}

function localTimeInProcess(time: string, process: GitProcess): number | undefined {
	const day = new Date(process.start / 1000)
	const [hour, minute, second] = time.split(":")
	day.setHours(Number(hour), Number(minute), Number(second.slice(0, 2)), 0)
	let timestamp = day.getTime() * 1000 + Number(second.slice(3).padEnd(6, "0"))
	// A command may cross local midnight. Test the adjacent date too.
	if (timestamp < process.start) {
		day.setDate(day.getDate() + 1)
		timestamp = day.getTime() * 1000 + Number(second.slice(3).padEnd(6, "0"))
	}
	return process.end !== undefined && timestamp >= process.start && timestamp <= process.end ? timestamp : undefined
}

function within(process: GitProcess, ancestor: GitProcess): boolean {
	return process === ancestor || process.sid.startsWith(`${ancestor.sid}/`)
}

/** Nested Git processes (hooks, sequencer commits) own the moment; unrelated concurrent ones make it ambiguous. */
function ownerAt(time: string, running: GitProcess[]): GitProcess | undefined {
	const candidates = running.filter((process) => localTimeInProcess(time, process) !== undefined)
	return candidates.find((process) => candidates.every((other) => within(process, other)))
}

/** HEAD moves made by a traced command that create or replay a commit. */
function headCommit(line: string, owner: GitProcess | undefined, replayed: string | undefined) {
	const sha = HEAD_UPDATE.exec(line)?.[1]
	if (!sha || !owner?.worktree) return
	const message = /\) "(.*)"$/.exec(line)?.[1] ?? ""
	// Checked first: the sequencer may hand a replayed pick to a nested `git commit`.
	if (REWRITE_MESSAGE.test(message)) {
		if (!["rebase", "cherry-pick", "commit"].includes(owner.command ?? "")) return
		return replayed ? { sha, rewrittenFrom: replayed } : undefined
	}
	if (owner.command === "commit" || (owner.command === "revert" && message.startsWith("revert:"))) return { sha }
	if (owner.command === "merge" && message.startsWith("merge ") && !message.includes("Fast-forward")) return { sha }
}

/** Ref transactions are attributable only when exactly one traced Git process owns their interval. */
function collectCommits(trace: string, refs: string, stopped?: { worktree: string; sha: string }): ObservedCommit[] {
	const running = processes(trace)
	const commits: ObservedCommit[] = []
	const repositories = new Map<string, string>()
	let pending: { sha: string; rewrittenFrom?: string; owner: GitProcess } | undefined
	let replayed: { sha: string; owner: GitProcess } | undefined
	for (const line of refs.split("\n")) {
		const time = /^(\d{2}:\d{2}:\d{2}\.\d{6})\s/.exec(line)?.[1]
		if (!time) continue
		if (/\btransaction \{$/.test(line)) pending = undefined
		const replay = REPLAYED.exec(line)
		if (replay) {
			const owner = ownerAt(time, running)
			replayed = owner && !/^0+$/.test(replay[1]) ? { sha: replay[1], owner } : undefined
		}
		if (HEAD_UPDATE.test(line)) {
			const owner = ownerAt(time, running)
			const commit = headCommit(
				line,
				owner,
				replayed && owner && within(owner, replayed.owner)
					? replayed.sha
					: owner?.worktree === stopped?.worktree
						? stopped?.sha
						: undefined,
			)
			pending = commit && owner ? { ...commit, owner } : undefined
			if (commit?.rewrittenFrom) {
				replayed = undefined
				stopped = undefined
			}
		}
		if (!/\bfinish: /.test(line)) continue
		if (pending && /\bfinish: 0$/.test(line) && ownerAt(time, running) === pending.owner) {
			const worktree = pending.owner.worktree
			if (worktree) {
				let repository = repositories.get(worktree)
				if (!repository) {
					const env = { ...process.env }
					for (const name of [
						"GIT_DIR",
						"GIT_WORK_TREE",
						"GIT_COMMON_DIR",
						"GIT_INDEX_FILE",
						"GIT_TRACE2_EVENT",
						"GIT_TRACE_REFS",
					])
						delete env[name]
					try {
						repository = realpathSync(
							execFileSync("git", ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
								encoding: "utf8",
								timeout: GIT_LOOKUP_TIMEOUT_MS,
								env,
								stdio: ["ignore", "pipe", "pipe"],
							}).trim(),
						)
					} catch (error) {
						console.warn("[work-attribution] Could not resolve Git commit repository:", error)
						pending = undefined
						continue
					}
					repositories.set(worktree, repository)
				}
				commits.push({
					sha: pending.sha,
					repository,
					worktree,
					...(pending.rewrittenFrom && { rewrittenFrom: pending.rewrittenFrom }),
				})
			}
		}
		pending = undefined
	}
	return commits
}

function readTrace(path: string): string {
	try {
		// ponytail: cap transient captures at 8 MiB; stream parsing if large Git commands need attribution.
		if (statSync(path).size > MAX_TRACE_BYTES) throw new Error("Git attribution trace exceeds 8 MiB")
		return readFileSync(path, "utf8")
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return ""
		throw error
	}
}

/** Observe only Git children of this bash call, without changing Git hooks, configuration, or reflogs. */
export function createCommitTrackingOperations(
	record: (commit: ObservedCommit) => void,
	local: BashOperations = createLocalBashOperations(),
): BashOperations {
	return {
		async exec(command, cwd, options) {
			let directory: string
			try {
				directory = mkdtempSync(join(tmpdir(), "kimchi-git-attribution-"))
			} catch (error) {
				console.warn("[work-attribution] Could not initialize Git trace:", error)
				return local.exec(command, cwd, options)
			}
			const trace = join(directory, "events")
			const refs = join(directory, "refs")
			const stopped = await stoppedReplay(cwd)
			try {
				const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
				// Keep upstream shell-environment construction, including its bundled binary PATH.
				return await local.exec(
					`export GIT_TRACE2_EVENT=${quote(trace)} GIT_TRACE_REFS=${quote(refs)}\n${command}`,
					cwd,
					options,
				)
			} finally {
				try {
					for (const commit of collectCommits(readTrace(trace), readTrace(refs), stopped)) record(commit)
				} catch (error) {
					console.warn("[work-attribution] Could not record Git commits:", error)
				} finally {
					try {
						rmSync(directory, { recursive: true, force: true })
					} catch (error) {
						console.warn("[work-attribution] Could not remove Git trace:", error)
					}
				}
			}
		},
	}
}

function readText(path: string): string {
	try {
		return readFileSync(path, "utf8")
	} catch {
		return ""
	}
}
/** Commits already attributed to this work, from this session's ledger and every session's summary. */
function recordedCommits(ctx: WorkContext, workId: string): Set<string> {
	const shas = new Set<string>()
	for (const line of readText(workLedgerPath(ctx)).split("\n")) {
		try {
			const row = JSON.parse(line)
			if (row.type === "commit" && row.workId === workId) shas.add(row.sha)
		} catch {}
	}
	try {
		for (const row of JSON.parse(readText(join(getAgentDir(), "work", workId, "work.json"))).commits) shas.add(row.sha)
	} catch {}
	return shas
}

/** Pin attribution before execution; background processes may outlive this session or work. */
export function createWorkCommitTrackingOperations(
	ctx: WorkContext,
	toolCallId: string,
	local: BashOperations = createLocalBashOperations(),
): BashOperations {
	const pinned = pinWorkContext(ctx)
	try {
		const workId = getWorkId(pinned)
		return createCommitTrackingOperations((commit) => {
			// Follow only copies of this work's own commits, not unrelated commits a rebase or pick replays.
			if (commit.rewrittenFrom && !recordedCommits(pinned, workId).has(commit.rewrittenFrom)) return
			appendWorkRecord(pinned, { type: "commit", ...commit, toolCallId }, workId)
		}, local)
	} catch (error) {
		console.warn("[work-attribution] Could not initialize Git attribution:", error)
		return local
	}
}

export function createCommitTrackingBashTool(ctx: WorkContext): ReturnType<typeof createBashToolDefinition> {
	return {
		...createBashToolDefinition(ctx.cwd),
		execute(toolCallId, params, signal, onUpdate, executionCtx) {
			const source = executionCtx ?? ctx
			const operations = createWorkCommitTrackingOperations(source, toolCallId)
			return createBashToolDefinition(source.cwd, { operations }).execute(
				toolCallId,
				params,
				signal,
				onUpdate,
				executionCtx,
			)
		},
	}
}
