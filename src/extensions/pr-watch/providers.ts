import {
	api,
	configuredHost,
	credential,
	defaultHost,
	githubAPI,
	githubGraphQL,
	pages,
	requestJSON,
} from "../pull-request-status/provider-api.js"
import { pullRequest, type Repository, repositoryPath, SHA } from "../pull-request-status/provider-records.js"
import { object } from "../work-attribution/summary.js"
import type { PRCheck, PRFeedback, PRSnapshot } from "./types.js"

const REQUEST_BUDGET_MS = 25_000
const DISCOVERY_BUDGET_MS = 60_000
const TEXT_LIMIT = 4000
const REVIEW_THREAD_PAGES = 20
const GITHUB_SEARCH_LIMIT = 1000
const SEARCH_PAGE_SIZE = 100
const GITLAB_DEVELOPER_ACCESS = 30
const GITLAB_MR_PATH = "/-/merge_requests/"

const trustedAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"])
const failedStates = new Set(["failure", "failed", "error", "timed_out", "action_required", "startup_failure"])
const pendingStates = new Set([
	"queued",
	"waiting_for_resource",
	"waiting_for_callback",
	"in_progress",
	"pending",
	"waiting",
	"requested",
	"running",
	"created",
	"preparing",
	"scheduled",
])
const passedStates = new Set(["success", "passed"])
const skippedStates = new Set(["neutral", "skipped", "cancelled", "canceled", "canceling", "manual", "stale"])

export interface PRSource {
	url: string
	provider: Repository["provider"]
	state: PRSnapshot["state"]
	branch: string
	cloneURL: string
}

function text(value: unknown): string {
	return typeof value === "string" ? value : ""
}

function rows(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value) || !value.every(object)) throw new Error("The Git provider returned invalid PR data.")
	return value
}

function withoutTrailingSlash(value: string): string {
	return value.endsWith("/") ? value.slice(0, -1) : value
}

function isDigits(value: string): boolean {
	return value !== "" && [...value].every((char) => char >= "0" && char <= "9")
}

function prPath(pathname: string): { provider: Repository["provider"]; name: string; number: string } | undefined {
	const path = withoutTrailingSlash(pathname)
	const parts = path.split("/")
	if (parts.length === 5 && parts[1] && parts[2] && parts[3] === "pull")
		return { provider: "github", name: `${parts[1]}/${parts[2]}`, number: parts[4] }
	const marker = path.lastIndexOf(GITLAB_MR_PATH)
	if (marker < 0) return undefined
	return { provider: "gitlab", name: path.slice(1, marker), number: path.slice(marker + GITLAB_MR_PATH.length) }
}

export function parsePRUrl(value: string) {
	const url = new URL(value)
	if (url.protocol !== "https:" || url.username || url.password)
		throw new Error("Use an HTTPS PR URL without credentials.")
	const path = prPath(url.pathname)
	if (
		!path ||
		!repositoryPath(path.name, path.provider) ||
		!isDigits(path.number) ||
		path.number.startsWith("0") ||
		!Number.isSafeInteger(Number(path.number))
	)
		throw new Error("Use a GitHub PR or GitLab merge request URL.")
	url.search = ""
	url.hash = ""
	const repository: Repository = { provider: path.provider, host: url.host, name: path.name }
	return { url: withoutTrailingSlash(url.href), repository, number: Number(path.number) }
}

async function readPR(value: string, signal: AbortSignal) {
	const target = parsePRUrl(value)
	const remote = target.repository
	const deadline = Date.now() + REQUEST_BUDGET_MS
	remote.token = await credential(remote, signal, deadline, new Map())
	const kind = remote.provider === "github" ? "pulls" : "merge_requests"
	const { value: record } = await requestJSON(remote, api(remote, `${kind}/${target.number}`), signal, deadline)
	const pr = pullRequest(record, remote, new Date().toISOString())
	if (pr.number !== target.number || pr.url !== target.url || !object(record))
		throw new Error("The provider returned a different PR.")
	const branch =
		remote.provider === "github" ? (object(record.head) ? record.head.ref : undefined) : record.source_branch
	if (typeof branch !== "string" || !branch || !SHA.test(pr.headSha))
		throw new Error("The PR source branch or repository is unavailable.")
	return { ...target, pullRequest: pr, branch, record, deadline }
}

/** The PR's source repository, which may be a fork, for cloning its branch. */
export async function readPRSource(value: string, signal: AbortSignal): Promise<PRSource> {
	const target = await readPR(value, signal)
	const { repository: remote, record } = target
	let source: unknown
	if (remote.provider === "github") {
		source = object(record.head) && object(record.head.repo) ? record.head.repo.clone_url : undefined
	} else {
		if (!Number.isSafeInteger(record.source_project_id)) throw new Error("The MR source project is unavailable.")
		const project = new URL(`/api/v4/projects/${record.source_project_id}`, `https://${remote.host}`)
		const { value } = await requestJSON(remote, project, signal, target.deadline)
		source = object(value) ? value.http_url_to_repo : undefined
	}
	const sourceURL = typeof source === "string" ? new URL(source) : undefined
	const sourcePath = sourceURL?.pathname.slice(1) ?? ""
	if (
		sourceURL?.protocol !== "https:" ||
		sourceURL.host !== remote.host ||
		sourceURL.username ||
		sourceURL.password ||
		sourceURL.search ||
		sourceURL.hash ||
		!repositoryPath(sourcePath.endsWith(".git") ? sourcePath.slice(0, -4) : sourcePath, remote.provider)
	)
		throw new Error("The PR source branch or repository is unavailable.")
	return {
		url: target.url,
		provider: remote.provider,
		state: target.pullRequest.state,
		branch: target.branch,
		cloneURL: sourceURL.href,
	}
}

function checkState(value: unknown): PRCheck["state"] {
	const state = text(value)
	if (failedStates.has(state)) return "failed"
	if (pendingStates.has(state)) return "pending"
	if (passedStates.has(state)) return "passed"
	if (skippedStates.has(state)) return "skipped"
	throw new Error(`The Git provider returned an unknown CI state: ${JSON.stringify(state)}.`)
}

export function githubChecks(checks: unknown, statuses: unknown): PRCheck[] {
	return [
		...rows(checks).map((check) => ({
			id: `check:${check.id}:${text(check.completed_at)}`,
			name: text(check.name),
			state: checkState(check.status === "completed" ? check.conclusion : check.status),
			url: text(check.details_url) || null,
			summary: object(check.output) ? text(check.output.summary).slice(0, TEXT_LIMIT) : "",
		})),
		...rows(statuses).map((status) => ({
			id: `status:${status.id}`,
			name: text(status.context),
			state: checkState(status.state),
			url: text(status.target_url) || null,
			summary: text(status.description).slice(0, TEXT_LIMIT),
		})),
	]
}

export function githubFeedback(threads: unknown, appComments = new Set<number>()): PRFeedback[] {
	return rows(threads).flatMap((thread) => {
		if (thread.isResolved === true || thread.isOutdated === true) return []
		if (!object(thread.comments)) throw new Error("GitHub returned an invalid review thread.")
		const comment = rows(thread.comments.nodes).at(-1)
		if (!comment || !text(comment.body).trim()) return []
		return [
			{
				id: `review:${thread.id}:${comment.id}:${text(comment.updatedAt)}`,
				author: object(comment.author) ? text(comment.author.login) : "",
				body: text(comment.body).slice(0, TEXT_LIMIT),
				url: text(comment.url),
				path: text(comment.path) || null,
				line: typeof comment.line === "number" ? comment.line : null,
				trusted:
					trustedAssociations.has(text(comment.authorAssociation)) ||
					(typeof comment.databaseId === "number" && appComments.has(comment.databaseId)),
			},
		]
	})
}

const reviewQuery = `query($owner:String!,$name:String!,$number:Int!,$after:String){
	repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid reviewThreads(first:50,after:$after){
		nodes{id isResolved isOutdated comments(last:1){nodes{id databaseId body url updatedAt path line author{login} authorAssociation}}}
		pageInfo{hasNextPage endCursor}
	}}}
}`

/** Comments posted by verified GitHub Apps, such as review bots. */
async function githubAppComments(remote: Repository, number: number, signal: AbortSignal, deadline: number) {
	const comments = rows(await pages(remote, api(remote, `pulls/${number}/comments?per_page=100`), signal, deadline))
	return new Set(
		comments.flatMap((comment) =>
			object(comment.performed_via_github_app) &&
			typeof comment.performed_via_github_app.id === "number" &&
			object(comment.user) &&
			comment.user.type === "Bot" &&
			typeof comment.id === "number"
				? [comment.id]
				: [],
		),
	)
}

async function githubReviewFeedback(
	remote: Repository,
	number: number,
	headSha: string,
	signal: AbortSignal,
	deadline: number,
): Promise<PRFeedback[]> {
	const endpoint = githubGraphQL(remote.host)
	const [owner, name] = remote.name.split("/")
	const appComments = await githubAppComments(remote, number, signal, deadline)
	const feedback: PRFeedback[] = []
	let after: string | null = null
	for (let page = 0; page < REVIEW_THREAD_PAGES; page++) {
		const { value } = await requestJSON(remote, endpoint, signal, deadline, {
			query: reviewQuery,
			variables: { owner, name, number, after },
		})
		const pull =
			object(value) && !value.errors && object(value.data) && object(value.data.repository)
				? value.data.repository.pullRequest
				: undefined
		if (!object(pull) || !object(pull.reviewThreads))
			throw new Error("GitHub review threads are unavailable. Check repository permissions.")
		if (pull.headRefOid !== headSha)
			throw new Error("The PR head changed while checking reviews. Kimchi will check again.")
		feedback.push(...githubFeedback(pull.reviewThreads.nodes, appComments))
		const pageInfo = pull.reviewThreads.pageInfo
		if (!object(pageInfo)) throw new Error("GitHub returned invalid review pagination.")
		if (pageInfo.hasNextPage === false) return feedback
		const next = text(pageInfo.endCursor)
		if (!next || next === after) throw new Error("GitHub returned invalid review pagination.")
		after = next
	}
	throw new Error("This PR has too many review threads to monitor safely.")
}

async function githubSnapshot(remote: Repository, number: number, headSha: string, signal: AbortSignal) {
	const deadline = Date.now() + REQUEST_BUDGET_MS
	const get = async (path: string) => (await requestJSON(remote, api(remote, path), signal, deadline)).value
	const [runs, statuses, feedback] = await Promise.all([
		get(`commits/${headSha}/check-runs?per_page=100`),
		get(`commits/${headSha}/status?per_page=100`),
		githubReviewFeedback(remote, number, headSha, signal, deadline),
	])
	if (
		!object(runs) ||
		!object(statuses) ||
		!Array.isArray(runs.check_runs) ||
		typeof runs.total_count !== "number" ||
		runs.total_count > runs.check_runs.length ||
		!Array.isArray(statuses.statuses) ||
		typeof statuses.total_count !== "number" ||
		statuses.total_count > statuses.statuses.length
	)
		throw new Error("The complete CI check list is unavailable for this PR.")
	return { checks: githubChecks(runs.check_runs, statuses.statuses), feedback }
}

async function gitlabSnapshot(
	remote: Repository,
	pr: { url: string; number: number },
	mr: Record<string, unknown>,
	signal: AbortSignal,
) {
	const deadline = Date.now() + REQUEST_BUDGET_MS
	const list = async (path: string) => rows(await pages(remote, api(remote, path), signal, deadline))
	const pipeline = object(mr.head_pipeline) ? mr.head_pipeline : null
	const jobs = pipeline ? await list(`pipelines/${pipeline.id}/jobs?per_page=100`) : []
	const checks: PRCheck[] = jobs.map((job) => ({
		id: `job:${job.id}:${text(job.finished_at)}`,
		name: text(job.name),
		state: job.allow_failure === true && job.status === "failed" ? "skipped" : checkState(job.status),
		url: text(job.web_url) || null,
		summary: text(job.failure_reason),
	}))
	// The parent includes child-pipeline failures that the jobs endpoint does not list.
	if (pipeline)
		checks.push({
			id: `pipeline:${pipeline.id}:${text(pipeline.updated_at)}`,
			name: "Pipeline",
			state: checkState(pipeline.status),
			url: text(pipeline.web_url) || null,
			summary: "",
		})
	const developers = new Map<string, boolean>()
	const isDeveloper = async (id: string) => {
		if (!developers.has(id)) {
			let trusted = false
			if (isDigits(id)) {
				try {
					const member = (await requestJSON(remote, api(remote, `members/all/${id}`), signal, deadline)).value
					trusted =
						object(member) && typeof member.access_level === "number" && member.access_level >= GITLAB_DEVELOPER_ACCESS
				} catch {
					// Non-members answer 404. A failed lookup is retried on the next poll; neither authorizes repairs,
					// and neither may block CI repairs, which never need reviewer trust.
				}
			}
			developers.set(id, trusted)
		}
		return developers.get(id) === true
	}
	const feedback: PRFeedback[] = []
	for (const discussion of await list(`merge_requests/${pr.number}/discussions?per_page=100`)) {
		const note = rows(discussion.notes)
			.filter((item) => item.system !== true)
			.at(-1)
		if (note?.resolvable !== true || note.resolved === true || !text(note.body).trim()) continue
		const author = object(note.author) ? note.author : {}
		const position = object(note.position) ? note.position : {}
		feedback.push({
			id: `review:${discussion.id}:${note.id}:${text(note.updated_at)}`,
			author: text(author.username),
			body: text(note.body).slice(0, TEXT_LIMIT),
			url: `${pr.url}#note_${note.id}`,
			path: text(position.new_path) || null,
			line: typeof position.new_line === "number" ? position.new_line : null,
			trusted: await isDeveloper(String(author.id ?? "")),
		})
	}
	return { checks, feedback }
}

export async function readPRSnapshot(url: string, signal: AbortSignal): Promise<PRSnapshot> {
	const { repository: remote, pullRequest: pr, branch, record } = await readPR(url, signal)
	const { checks, feedback } =
		remote.provider === "github"
			? await githubSnapshot(remote, pr.number, pr.headSha, signal)
			: await gitlabSnapshot(remote, pr, record, signal)
	return {
		provider: remote.provider,
		repository: remote.name,
		number: pr.number,
		title: pr.title ?? "",
		url: pr.url,
		branch,
		headSha: pr.headSha,
		state: pr.state,
		checks,
		feedback,
	}
}

async function gitlabAuthoredMRs(remote: Repository, base: string, signal: AbortSignal, deadline: number) {
	const { value: user } = await requestJSON(remote, new URL("/api/v4/user", base), signal, deadline)
	if (!object(user) || !Number.isSafeInteger(user.id) || typeof user.id !== "number" || user.id <= 0)
		throw new Error("GitLab did not return the signed-in user.")
	const endpoint = new URL("/api/v4/merge_requests", base)
	endpoint.search = new URLSearchParams({ scope: "created_by_me", state: "opened", per_page: "100" }).toString()
	const urls = (await pages(remote, endpoint, signal, deadline)).map((record) => {
		if (
			!object(record) ||
			!object(record.author) ||
			record.author.id !== user.id ||
			record.state !== "opened" ||
			typeof record.web_url !== "string"
		)
			throw new Error("GitLab returned an MR outside the requested author or state.")
		const parsed = parsePRUrl(record.web_url)
		if (parsed.repository.host !== remote.host || parsed.repository.provider !== "gitlab")
			throw new Error("GitLab returned an MR on a different host.")
		return parsed.url
	})
	return [...new Set(urls)]
}

async function githubAuthoredPRs(remote: Repository, signal: AbortSignal, deadline: number) {
	const base = githubAPI(remote.host)
	const urls = new Set<string>()
	for (let page = 1; ; page++) {
		const url = new URL(`${base}/search/issues`)
		url.search = new URLSearchParams({
			q: "is:pr is:open author:@me",
			per_page: String(SEARCH_PAGE_SIZE),
			page: String(page),
		}).toString()
		const { value } = await requestJSON(remote, url, signal, deadline)
		if (
			!object(value) ||
			!Array.isArray(value.items) ||
			typeof value.total_count !== "number" ||
			value.incomplete_results !== false
		)
			throw new Error("GitHub returned an incomplete PR search. Supply the requested PR URLs instead.")
		if (value.total_count > GITHUB_SEARCH_LIMIT)
			throw new Error(
				"GitHub search returns at most 1000 results. Narrow the request or supply PR URLs; the watcher has no PR-count limit.",
			)
		for (const item of value.items) {
			if (!object(item) || !object(item.pull_request) || typeof item.html_url !== "string")
				throw new Error("GitHub returned an invalid PR search result.")
			const parsed = parsePRUrl(item.html_url)
			if (parsed.repository.host !== remote.host) throw new Error("GitHub returned a PR on a different host.")
			urls.add(parsed.url)
		}
		if (page * SEARCH_PAGE_SIZE >= value.total_count) return [...urls]
		if (!value.items.length) throw new Error("GitHub returned an incomplete PR search. Supply PR URLs instead.")
	}
}

/** Open PRs or MRs authored by the signed-in user, found only on explicit request. */
export async function discoverMyOpenPRs(
	provider: Repository["provider"] = "github",
	host: string | undefined,
	signal: AbortSignal,
): Promise<string[]> {
	const address = host === undefined ? defaultHost(provider) : configuredHost(host)
	if (!address) throw new Error("Use a Git provider hostname without credentials or a path.")
	const remote: Repository = { provider, host: address, name: "_/_" }
	const deadline = Date.now() + DISCOVERY_BUDGET_MS
	remote.token = await credential(remote, signal, deadline, new Map())
	if (!remote.token)
		throw new Error(
			`Sign in to ${provider === "github" ? "GitHub" : "GitLab"} for ${remote.host} before finding your PRs or MRs.`,
		)
	return provider === "gitlab"
		? gitlabAuthoredMRs(remote, api(remote).origin, signal, deadline)
		: githubAuthoredPRs(remote, signal, deadline)
}
