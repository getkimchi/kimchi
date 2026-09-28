import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	type BashOperations,
	createBashToolDefinition,
	createLocalBashOperations,
} from "@earendil-works/pi-coding-agent"

import { appendWorkRecord, getWorkId, type WorkContext } from "../work-attribution.js"

export interface ObservedCommit {
	sha: string
	repository: string
	worktree: string
}

interface GitProcess {
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
		if (event.event === "start") byId.set(event.sid, { start: instant(event.time) })
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

function ownerAt(time: string, running: GitProcess[]): GitProcess | undefined {
	const candidates = running.filter((process) => localTimeInProcess(time, process) !== undefined)
	return candidates.length === 1 ? candidates[0] : undefined
}

/** Ref transactions are attributable only when exactly one traced Git process owns their interval. */
function collectCommits(trace: string, refs: string): ObservedCommit[] {
	const running = processes(trace)
	const commits: ObservedCommit[] = []
	const repositories = new Map<string, string>()
	let pending: { sha: string; owner: GitProcess } | undefined
	for (const line of refs.split("\n")) {
		const time = /^(\d{2}:\d{2}:\d{2}\.\d{6})\s/.exec(line)?.[1]
		if (!time) continue
		if (/\btransaction \{$/.test(line)) pending = undefined
		const update = /\b\d+: HEAD [0-9a-f]+ -> ([0-9a-f]{40}|[0-9a-f]{64}) \(/.exec(line)
		if (update) {
			const owner = ownerAt(time, running)
			pending = owner?.command === "commit" && owner.worktree ? { sha: update[1], owner } : undefined
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
					repository = realpathSync(
						execFileSync("git", ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
							encoding: "utf8",
							timeout: 2000,
							env,
							stdio: ["ignore", "pipe", "pipe"],
						}).trim(),
					)
					repositories.set(worktree, repository)
				}
				commits.push({ sha: pending.sha, repository, worktree })
			}
		}
		pending = undefined
	}
	return commits
}

function readTrace(path: string): string {
	try {
		// ponytail: cap transient captures at 8 MiB; stream parsing if large Git commands need attribution.
		if (statSync(path).size > 8 * 1024 * 1024) throw new Error("Git attribution trace exceeds 8 MiB")
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
			const directory = mkdtempSync(join(tmpdir(), "kimchi-git-attribution-"))
			const trace = join(directory, "events")
			const refs = join(directory, "refs")
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
					for (const commit of collectCommits(readTrace(trace), readTrace(refs))) record(commit)
				} catch (error) {
					console.warn("[work-attribution] Could not record Git commits:", error)
				} finally {
					rmSync(directory, { recursive: true, force: true })
				}
			}
		},
	}
}

/** Pin attribution before execution; background processes may outlive this session or work. */
export function createWorkCommitTrackingOperations(
	ctx: WorkContext,
	toolCallId: string,
	local?: BashOperations,
): BashOperations {
	const sessionId = ctx.sessionManager.getSessionId()
	const pinned = { cwd: ctx.cwd, sessionManager: { getSessionId: () => sessionId } }
	const workId = getWorkId(pinned)
	return createCommitTrackingOperations((commit) => {
		appendWorkRecord(pinned, { type: "commit", ...commit, toolCallId }, workId)
	}, local)
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
