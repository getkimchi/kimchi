import { type ExecFileException, execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { appendWorkRecord } from "../work-attribution.js"
import { readWorkRecords } from "./summary.js"

const PASS_BUDGET_MS = 10_000
const COMMAND_TIMEOUT_MS = 5000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MTIME_SLACK_MS = 2000
const SHA = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i

export interface WorkPullRequest {
	url: string
	number: number
	state: "open" | "closed" | "merged"
	repository: string
	host: string
	headSha: string
	mergeCommitSha: string | null
	mergedAt: string | null
	closedAt: string | null
	checkedAt: string
}
export interface WorkPullRequestLookup {
	status: "pending" | "linked" | "error"
	checkedAt: string
	error?: string
}
export interface WorkPullRequestUpdate {
	workId: string
	sessionId: string
	cwd: string
	repository: string
	worktree: string
	sha: string
	prLookup?: WorkPullRequestLookup
	pullRequests: WorkPullRequest[]
}
interface DiscoveryState {
	commits: Map<string, WorkPullRequestUpdate>
	readThrough?: number
	nextCommit?: string
	running?: Promise<void>
}
interface Repository {
	host: string
	name: string
}
const states = new Map<string, DiscoveryState>()

function discoveryState(directory: string): DiscoveryState {
	const state = states.get(directory) ?? { commits: new Map<string, WorkPullRequestUpdate>() }
	states.set(directory, state)
	return state
}

class LookupError extends Error {
	constructor(
		message: string,
		readonly missing = false,
	) {
		super(message)
	}
}
function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}
function timestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value))
}
function nullableTimestamp(value: unknown): value is string | null {
	return value === null || timestamp(value)
}
function githubURL(value: unknown): URL {
	if (typeof value === "string") {
		try {
			const url = new URL(value)
			if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash) return url
		} catch {}
	}
	throw new LookupError("GitHub returned an invalid repository or pull request.")
}
function pullRequest(value: unknown, host: string, checkedAt: string): WorkPullRequest {
	if (
		!object(value) ||
		!Number.isSafeInteger(value.number) ||
		typeof value.number !== "number" ||
		value.number < 1 ||
		(value.state !== "open" && value.state !== "closed") ||
		!object(value.head) ||
		typeof value.head.sha !== "string" ||
		!SHA.test(value.head.sha) ||
		(value.merge_commit_sha !== null &&
			(typeof value.merge_commit_sha !== "string" || !SHA.test(value.merge_commit_sha))) ||
		!nullableTimestamp(value.merged_at) ||
		!nullableTimestamp(value.closed_at)
	)
		throw new LookupError("GitHub returned an invalid pull request.")
	const url = githubURL(value.html_url)
	const path = /^\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/.exec(url.pathname)
	if (url.host !== host || !path || Number(path[2]) !== value.number)
		throw new LookupError("GitHub returned a pull request from an unexpected repository.")
	return {
		url: url.href,
		number: value.number,
		state: value.merged_at ? "merged" : value.state,
		repository: path[1],
		host,
		headSha: value.head.sha,
		mergeCommitSha: value.merge_commit_sha,
		mergedAt: value.merged_at,
		closedAt: value.closed_at,
		checkedAt,
	}
}
function storedPullRequests(value: unknown): WorkPullRequest[] {
	if (!Array.isArray(value)) return []
	return value.flatMap((item) => {
		if (!object(item) || typeof item.host !== "string" || !timestamp(item.checkedAt)) return []
		try {
			return [
				pullRequest(
					{
						html_url: item.url,
						number: item.number,
						state: item.state === "merged" ? "closed" : item.state,
						head: { sha: item.headSha },
						merge_commit_sha: item.mergeCommitSha,
						merged_at: item.mergedAt,
						closed_at: item.closedAt,
					},
					item.host,
					item.checkedAt,
				),
			]
		} catch {
			return []
		}
	})
}
function mergePullRequests(...groups: WorkPullRequest[][]): WorkPullRequest[] {
	const merged = new Map<string, WorkPullRequest>()
	for (const group of groups)
		for (const item of group) {
			const previous = merged.get(item.url)
			if (!previous || Date.parse(item.checkedAt) >= Date.parse(previous.checkedAt)) merged.set(item.url, item)
		}
	return [...merged.values()]
}
function commitKey(row: WorkPullRequestUpdate): string {
	return JSON.stringify([row.workId, row.sessionId, row.repository, row.worktree, row.sha])
}
function readCommits(agentDir: string, state: DiscoveryState): void {
	const started = Date.now()
	const records = readWorkRecords(
		agentDir,
		state.readThrough === undefined ? undefined : state.readThrough - MTIME_SLACK_MS,
	)
	for (const row of records) {
		if (
			row.type !== "commit" ||
			typeof row.cwd !== "string" ||
			typeof row.repository !== "string" ||
			typeof row.worktree !== "string" ||
			typeof row.sha !== "string" ||
			!SHA.test(row.sha)
		)
			continue
		const commit: WorkPullRequestUpdate = {
			workId: row.workId,
			sessionId: row.sessionId,
			cwd: row.cwd,
			repository: row.repository,
			worktree: row.worktree,
			sha: row.sha,
			pullRequests: [],
		}
		const key = commitKey(commit)
		const existing = state.commits.get(key)
		const lookup = row.prLookup
		commit.prLookup = existing?.prLookup
		if (
			object(lookup) &&
			timestamp(lookup.checkedAt) &&
			(!commit.prLookup || Date.parse(lookup.checkedAt) >= Date.parse(commit.prLookup.checkedAt))
		) {
			const status = lookup.status
			if (status === "pending" || status === "linked" || status === "error")
				commit.prLookup = {
					status,
					checkedAt: lookup.checkedAt,
					...(typeof lookup.error === "string" ? { error: lookup.error } : {}),
				}
		}
		commit.pullRequests = mergePullRequests(existing?.pullRequests ?? [], storedPullRequests(row.pullRequests))
		state.commits.set(key, commit)
	}
	// Never advance this checkpoint after a failed or incomplete source read.
	state.readThrough = started
}
/** Keep raw CLI stderr out of journals and the UI: it can contain credentials. */
function cliError(error: ExecFileException, stderr: string): LookupError {
	if (error.code === "ENOENT") return new LookupError("GitHub CLI is not installed.")
	if (error.code === 4 || /HTTP 401|gh auth login|not logged|authentication required/i.test(stderr))
		return new LookupError("GitHub CLI is not signed in. Run gh auth login.")
	if (/rate limit|HTTP 429/i.test(stderr)) return new LookupError("GitHub rate limit reached. Kimchi will retry.")
	if (/HTTP 403/i.test(stderr))
		return new LookupError("GitHub denied access. Check gh authentication and repository permissions.")
	if (/HTTP 404/i.test(stderr)) return new LookupError("GitHub could not find this commit or pull request yet.", true)
	if (/no git remotes|none of the git remotes|not a git repository/i.test(stderr))
		return new LookupError("This repository has no configured GitHub remote.")
	if (error.killed) return new LookupError("GitHub lookup timed out. Kimchi will retry.")
	if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
		return new LookupError("GitHub response exceeded the lookup limit.")
	return new LookupError("GitHub lookup failed. Check gh authentication and repository access.")
}
function gh(args: string[], cwd: string, signal: AbortSignal, deadline: number): Promise<unknown> {
	signal.throwIfAborted()
	const remaining = deadline - Date.now()
	if (remaining <= 0) throw new LookupError("GitHub lookup timed out. Kimchi will retry.")
	const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1" }
	for (const key of ["GH_REPO", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[key]
	return new Promise((done, reject) => {
		execFile(
			"gh",
			args,
			{
				cwd,
				env,
				signal,
				encoding: "utf8",
				timeout: Math.min(COMMAND_TIMEOUT_MS, remaining),
				maxBuffer: MAX_RESPONSE_BYTES,
			},
			(error, stdout, stderr) => {
				if (error) {
					reject(cliError(error, stderr))
					return
				}
				try {
					done(JSON.parse(stdout))
				} catch {
					reject(new LookupError("GitHub returned invalid JSON."))
				}
			},
		)
	})
}
async function repositoryIdentity(path: string, signal: AbortSignal, deadline: number): Promise<Repository> {
	if (!existsSync(path)) throw new LookupError("The local Git repository is unavailable.")
	const result = await gh(["repo", "view", "--json", "nameWithOwner,url"], path, signal, deadline)
	if (!object(result) || typeof result.nameWithOwner !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(result.nameWithOwner))
		throw new LookupError("GitHub returned an invalid repository.")
	const url = githubURL(result.url)
	if (url.pathname !== `/${result.nameWithOwner}`) throw new LookupError("GitHub returned an invalid repository.")
	return { host: url.host, name: result.nameWithOwner }
}
function api(repository: Repository, endpoint: string): string[] {
	return ["api", "--method", "GET", "--hostname", repository.host, `repos/${repository.name}/${endpoint}`]
}

export interface BranchPullRequest {
	branch: string
	pullRequest?: WorkPullRequest
}
async function currentBranch(cwd: string, signal: AbortSignal): Promise<string | undefined> {
	signal.throwIfAborted()
	const env = { ...process.env }
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[key]
	return new Promise((done, reject) => {
		execFile(
			"git",
			["-C", cwd, "symbolic-ref", "--quiet", "--short", "HEAD"],
			{
				cwd,
				env,
				signal,
				encoding: "utf8",
				timeout: 2000,
				maxBuffer: 64 * 1024,
			},
			(error, stdout) => {
				if (signal.aborted) reject(signal.reason)
				else done(error ? undefined : stdout.trim() || undefined)
			},
		)
	})
}
/** A branch status check has no work identity, ledger, summary, or attribution side effects. */
export async function lookupBranchPullRequest(
	cwd: string,
	signal: AbortSignal,
	onBranch?: (branch: string | undefined) => void,
): Promise<BranchPullRequest | undefined> {
	const branch = await currentBranch(cwd, signal)
	onBranch?.(branch)
	if (!branch) return undefined
	const deadline = Date.now() + PASS_BUDGET_MS
	let pull: WorkPullRequest | undefined
	let failure: unknown
	try {
		const remote = await repositoryIdentity(cwd, signal, deadline)
		const name = remote.host === "github.com" ? remote.name : `${remote.host}/${remote.name}`
		const values = await gh(
			[
				"pr",
				"list",
				"--head",
				branch,
				"--state",
				"all",
				"--limit",
				"1",
				"--repo",
				name,
				"--json",
				"number,url,state,headRefName,headRefOid,mergeCommit,mergedAt,closedAt",
			],
			cwd,
			signal,
			deadline,
		)
		if (!Array.isArray(values)) throw new LookupError("GitHub returned invalid pull requests.")
		if (values.length) {
			const value = values[0]
			if (!object(value)) throw new LookupError("GitHub returned an invalid pull request.")
			if (value.headRefName !== branch) throw new LookupError("GitHub returned a pull request for a different branch.")
			pull = pullRequest(
				{
					html_url: value.url,
					number: value.number,
					state:
						value.state === "OPEN"
							? "open"
							: value.state === "CLOSED" || value.state === "MERGED"
								? "closed"
								: undefined,
					head: { sha: value.headRefOid },
					merge_commit_sha: object(value.mergeCommit) ? value.mergeCommit.oid : null,
					merged_at: value.mergedAt,
					closed_at: value.closedAt,
				},
				remote.host,
				new Date().toISOString(),
			)
		}
	} catch (error) {
		failure = error
	}
	// Ignore a result for a branch that was checked out while GitHub was responding.
	if ((await currentBranch(cwd, signal)) !== branch) return undefined
	if (failure) throw failure
	return { branch, pullRequest: pull }
}

async function scan(
	agentDir: string,
	state: DiscoveryState,
	signal: AbortSignal,
	assertLease: () => void,
	onUpdate?: (update: WorkPullRequestUpdate) => void,
): Promise<void> {
	signal.throwIfAborted()
	readCommits(agentDir, state)
	const groups = new Map<string, WorkPullRequestUpdate[]>()
	for (const commit of state.commits.values()) {
		onUpdate?.(commit)
		const key = JSON.stringify([commit.repository, commit.sha])
		const group = groups.get(key) ?? []
		group.push(commit)
		groups.set(key, group)
	}
	const jobs = [...groups.entries()]
	const start = Math.max(
		0,
		jobs.findIndex(([key]) => key === state.nextCommit),
	)
	const deadline = Date.now() + PASS_BUDGET_MS
	const repositories = new Map<string, Promise<Repository>>()
	const associations = new Map<string, Promise<WorkPullRequest[]>>()
	const refreshed = new Map<string, Promise<WorkPullRequest>>()
	for (let offset = 0; offset < jobs.length && Date.now() < deadline; offset++) {
		signal.throwIfAborted()
		const index = (start + offset) % jobs.length
		const [key, commits] = jobs[index]
		state.nextCommit = jobs[(index + 1) % jobs.length][0]
		const known = mergePullRequests(...commits.map((commit) => commit.pullRequests))
		if (
			known.length &&
			known.every((pr) => pr.state === "merged") &&
			commits.every(
				(commit) =>
					commit.prLookup?.status === "linked" && JSON.stringify(commit.pullRequests) === JSON.stringify(known),
			)
		)
			continue
		const first = commits[0]
		let found: WorkPullRequest[] = []
		let failure: LookupError | undefined
		try {
			let identity = repositories.get(first.repository)
			if (!identity) {
				identity = repositoryIdentity(first.repository, signal, deadline)
				repositories.set(first.repository, identity)
			}
			const remote = await identity
			const requestKey = JSON.stringify([remote.host, remote.name, first.sha])
			let request = associations.get(requestKey)
			if (!request) {
				request = gh(
					[...api(remote, `commits/${first.sha}/pulls`), "--paginate", "--slurp"],
					agentDir,
					signal,
					deadline,
				).then((pages) => {
					if (!Array.isArray(pages) || !pages.every(Array.isArray))
						throw new LookupError("GitHub returned invalid pull request pages.")
					return pages.flat().map((value) => pullRequest(value, remote.host, new Date().toISOString()))
				})
				associations.set(requestKey, request)
			}
			found = await request
		} catch (error) {
			signal.throwIfAborted()
			if (!(error instanceof LookupError)) throw error
			failure = error
		}
		// A force push can remove the old SHA from commit/pulls. The PR identity remains useful.
		let refreshedKnown = false
		let refreshFailure: LookupError | undefined
		for (const previous of known.sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt))) {
			if (previous.state === "merged" || found.some((item) => item.url === previous.url)) continue
			try {
				let request = refreshed.get(previous.url)
				if (!request) {
					request = gh(
						api({ host: previous.host, name: previous.repository }, `pulls/${previous.number}`),
						agentDir,
						signal,
						deadline,
					).then((value) => pullRequest(value, previous.host, new Date().toISOString()))
					refreshed.set(previous.url, request)
				}
				found.push(await request)
				refreshedKnown = true
			} catch (error) {
				signal.throwIfAborted()
				if (!(error instanceof LookupError)) throw error
				refreshFailure = error
				if (Date.now() >= deadline) break
			}
		}
		failure = refreshFailure ?? (failure?.missing && refreshedKnown ? undefined : failure)
		const pullRequests = mergePullRequests(known, found)
		const prLookup: WorkPullRequestLookup = {
			status: failure ? "error" : pullRequests.length ? "linked" : "pending",
			checkedAt: new Date().toISOString(),
			...(failure ? { error: failure.message } : {}),
		}
		for (const commit of commits) {
			signal.throwIfAborted()
			assertLease()
			const update = { ...commit, pullRequests, prLookup }
			appendWorkRecord(
				{ cwd: commit.cwd, sessionManager: { getSessionId: () => commit.sessionId } },
				{
					type: "commit",
					sha: commit.sha,
					repository: commit.repository,
					worktree: commit.worktree,
					pullRequests,
					prLookup,
				},
				commit.workId,
				join(agentDir, "work-attribution", `${encodeURIComponent(commit.sessionId)}.jsonl`),
			)
			state.commits.set(commitKey(commit), update)
			onUpdate?.(update)
		}
		// Keep the next job stable even if source records append during this pass.
		if (jobs.length === 1) state.nextCommit = key
	}
}

/** Every process can display persisted results, including while another process owns discovery. */
export function readWorkPullRequestUpdates(agentDir: string): WorkPullRequestUpdate[] {
	const directory = resolve(agentDir)
	const state = discoveryState(directory)
	readCommits(directory, state)
	return [...state.commits.values()]
}

/** The caller owns the cross-process lease; this guard also prevents overlapping in-process passes. */
export function reconcileWorkPullRequests(
	agentDir: string,
	signal: AbortSignal,
	assertLease: () => void,
	onUpdate?: (update: WorkPullRequestUpdate) => void,
): Promise<void> {
	const directory = resolve(agentDir)
	const state = discoveryState(directory)
	if (!state.running)
		state.running = scan(directory, state, signal, assertLease, onUpdate).finally(() => {
			state.running = undefined
		})
	return state.running
}
