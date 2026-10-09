/** Discovers the PRs and MRs of recorded commits: lookup scheduling, the check cache and the journal updates. */
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { open, rename, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { readWorkRecords } from "../work-attribution/summary.js"
import { appendWorkRecord } from "../work-attribution.js"
import { mergePullRequestLinks as mergePullRequests, pullRequestKey } from "./links.js"
import { api, credential, pages, repositoryIdentity, requestJSON } from "./provider-api.js"
import {
	LookupError,
	lookupFailureReason,
	object,
	pullRequest,
	type Repository,
	SHA,
	storedPullRequests,
	timestamp,
} from "./provider-records.js"

export const PASS_BUDGET_MS = 10_000

const MTIME_SLACK_MS = 2000

const DAY_MS = 24 * 60 * 60 * 1000

/** A commit still without a PR this long after it was first recorded is no longer checked. */
export const LOOKUP_WINDOW_MS = 32 * DAY_MS

/** Failures saved before this process started are retried once, so a fixed token need not wait out the backoff. */
const PROCESS_STARTED = Date.now()

/** When each repository and SHA was last checked, including checks whose unchanged result was not appended. */
const LOOKUP_CHECKS = "pr-checks.json"

export interface WorkPullRequest {
	provider?: "github" | "gitlab"
	/** Provider IDs belong to the target repository, including fork contributions. */
	id?: string
	repositoryId?: string
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
	/** An error the user cannot act on: a retryable outage, or a repository without a supported provider. */
	reason?: "retry" | "unsupported"
}

export interface WorkPullRequestUpdate {
	workId: string
	sessionId: string
	cwd: string
	repository: string
	worktree: string
	sha: string
	/** When Kimchi first recorded this commit; lookups slow down as it ages. */
	recordedAt?: string
	prLookup?: WorkPullRequestLookup
	pullRequests: WorkPullRequest[]
}

interface DiscoveryState {
	commits: Map<string, WorkPullRequestUpdate>
	readThrough?: number
	nextCommit?: string
	running?: Promise<void>
}

const states = new Map<string, DiscoveryState>()

function discoveryState(directory: string): DiscoveryState {
	const state = states.get(directory) ?? { commits: new Map<string, WorkPullRequestUpdate>() }
	states.set(directory, state)
	return state
}

function lookupResult(commit: WorkPullRequestUpdate): string {
	return JSON.stringify([
		commit.prLookup?.status,
		commit.prLookup?.error,
		commit.prLookup?.reason,
		commit.pullRequests
			.map(({ checkedAt: _checkedAt, ...pr }) => pr)
			.sort((a, b) => pullRequestKey(a).localeCompare(pullRequestKey(b))),
	])
}

/**
 * Checks slow down in proportion to a commit's age: new pushes link on the next pass, old commits at most daily,
 * and ones without a PR stop after the upload window. `lastChecked` comes from the check cache, because an
 * unchanged result keeps the journal's older `checkedAt`.
 */

function lookupDue(commits: WorkPullRequestUpdate[], lastChecked = 0, now = Date.now()): boolean {
	let latest: WorkPullRequestLookup | undefined
	for (const { prLookup } of commits) {
		if (!prLookup) return true
		if (!latest || Date.parse(prLookup.checkedAt) > Date.parse(latest.checkedAt)) latest = prLookup
	}
	if (!latest) return true
	const age = now - Math.min(...commits.map((commit) => Date.parse(commit.recordedAt ?? "") || now))
	// Whatever the last result, including an error or an unsupported remote. Known links keep refreshing.
	if (age > LOOKUP_WINDOW_MS && commits.every((commit) => !commit.pullRequests.length)) return false
	if (latest.error && !latest.reason && Date.parse(latest.checkedAt) < PROCESS_STARTED) return true
	return now - Math.max(Date.parse(latest.checkedAt), lastChecked) >= Math.min(DAY_MS, age / 16)
}

function groupKey(commit: Pick<WorkPullRequestUpdate, "repository" | "sha">): string {
	return JSON.stringify([commit.repository, commit.sha])
}

interface LookupChecks {
	saved?: string
	checkedAt: Map<string, number>
}

/** The lease owner reads the check cache before each pass; another process may have written it. */
function readLookupChecks(agentDir: string): LookupChecks {
	const checks: LookupChecks = { checkedAt: new Map() }
	let value: unknown
	try {
		checks.saved = readFileSync(join(agentDir, "work-attribution", LOOKUP_CHECKS), "utf8")
		value = JSON.parse(checks.saved)
	} catch {
		// A missing or damaged cache only costs one more check per commit.
		return checks
	}
	if (!object(value)) return checks
	for (const [repository, commits] of Object.entries(value)) {
		if (!object(commits)) continue
		for (const [sha, checkedAt] of Object.entries(commits)) {
			const time = timestamp(checkedAt) ? Date.parse(checkedAt) : Number.NaN
			// A future time, for example after a clock change, must not postpone checks.
			if (SHA.test(sha) && time <= Date.now()) checks.checkedAt.set(groupKey({ repository, sha }), time)
		}
	}
	return checks
}

/** Durably saves at most once per pass, only after a change, and forgets commits no longer recorded. */
async function saveLookupChecks(
	agentDir: string,
	groups: Map<string, WorkPullRequestUpdate[]>,
	checks: LookupChecks,
	assertLease: () => void,
): Promise<void> {
	const now = Date.now()
	const value: Record<string, Record<string, string>> = {}
	for (const key of [...checks.checkedAt.keys()].sort()) {
		const time = checks.checkedAt.get(key) ?? 0
		// The backoff never exceeds a day, so an older check no longer delays the next one.
		if (!groups.has(key) || now - time >= DAY_MS) continue
		const [repository, sha]: [string, string] = JSON.parse(key)
		value[repository] ??= {}
		value[repository][sha] = new Date(time).toISOString()
	}

	const contents = `${JSON.stringify(value)}\n`
	if (contents === (checks.saved ?? "{}\n")) return
	const directory = join(agentDir, "work-attribution")
	const temporary = join(directory, `.${LOOKUP_CHECKS}-${randomUUID()}.tmp`)
	try {
		const file = await open(temporary, "wx", 0o600)
		try {
			await file.writeFile(contents)
			await file.sync()
		} finally {
			await file.close()
		}
		assertLease()
		await rename(temporary, join(directory, LOOKUP_CHECKS))
	} finally {
		await rm(temporary, { force: true })
	}
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
		commit.recordedAt = existing?.recordedAt
		if (timestamp(row.recordedAt) && !(Date.parse(commit.recordedAt ?? "") <= Date.parse(row.recordedAt)))
			commit.recordedAt = row.recordedAt
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
					...(lookup.reason === "retry" || lookup.reason === "unsupported" ? { reason: lookup.reason } : {}),
				}
		}
		commit.pullRequests = mergePullRequests(existing?.pullRequests ?? [], storedPullRequests(row.pullRequests))
		state.commits.set(key, commit)
	}
	// Never advance this checkpoint after a failed or incomplete source read.
	state.readThrough = started
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
		const key = groupKey(commit)
		const group = groups.get(key) ?? []
		group.push(commit)
		groups.set(key, group)
	}

	const checks = readLookupChecks(agentDir)
	const jobs = [...groups.entries()]
	const start = Math.max(
		0,
		jobs.findIndex(([key]) => key === state.nextCommit),
	)

	const deadline = Date.now() + PASS_BUDGET_MS
	const repositories = new Map<string, Promise<Repository>>()
	const tokens = new Map<string, Promise<string | undefined>>()
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
		if (!lookupDue(commits, checks.checkedAt.get(key))) continue
		const first = commits[0]
		let found: WorkPullRequest[] = []
		let failure: LookupError | undefined
		try {
			let identity = repositories.get(first.repository)
			if (!identity) {
				identity = repositoryIdentity(first.repository, signal, deadline, tokens)
				repositories.set(first.repository, identity)
			}

			const remote = await identity
			const requestKey = JSON.stringify([remote.host, remote.name, first.sha])
			let request = associations.get(requestKey)
			if (!request) {
				const url = api(
					remote,
					remote.provider === "gitlab"
						? `repository/commits/${first.sha}/merge_requests`
						: `commits/${first.sha}/pulls`,
				)
				url.searchParams.set("per_page", "100")
				request = pages(remote, url, signal, deadline).then((values) =>
					values.map((value) => pullRequest(value, remote, new Date().toISOString())),
				)
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
			if (previous.state === "merged" || found.some((item) => pullRequestKey(item) === pullRequestKey(previous)))
				continue
			try {
				let request = refreshed.get(previous.url)
				if (!request) {
					const remote: Repository = {
						provider: previous.provider ?? "github",
						host: previous.host,
						name: previous.repository,
					}
					remote.token = await credential(remote, signal, deadline, tokens)
					request = requestJSON(
						remote,
						api(remote, `${remote.provider === "gitlab" ? "merge_requests" : "pulls"}/${previous.number}`),
						signal,
						deadline,
					).then(({ value }) => pullRequest(value, remote, new Date().toISOString()))
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
		failure = refreshFailure ?? (failure?.kind === "missing" && refreshedKnown ? undefined : failure)
		const pullRequests = mergePullRequests(known, found)
		const reason = lookupFailureReason(failure)
		const prLookup: WorkPullRequestLookup = {
			status: failure ? "error" : pullRequests.length ? "linked" : "pending",
			checkedAt: new Date().toISOString(),
			...(failure ? { error: failure.message } : {}),
			...(reason ? { reason } : {}),
		}
		for (const commit of commits) {
			signal.throwIfAborted()
			assertLease()
			const update = { ...commit, pullRequests, prLookup }
			if (lookupResult(commit) !== lookupResult(update))
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
		checks.checkedAt.set(key, Date.parse(prLookup.checkedAt))
		// Keep the next job stable even if source records append during this pass.
		if (jobs.length === 1) state.nextCommit = key
	}
	await saveLookupChecks(agentDir, groups, checks, assertLease)
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
