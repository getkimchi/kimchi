import { lookupBranchPullRequest } from "../pull-request-status/branch-status.js"
import { api, pages, repositoryIdentity, requestJSON } from "../pull-request-status/provider-api.js"
import type { Repository } from "../pull-request-status/provider-records.js"
import { object } from "../work-attribution/summary.js"
import type { PRCheck, PRFeedback, PRSnapshot } from "./types.js"

const trustedAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"])
const failed = new Set(["failure", "failed", "error", "timed_out", "action_required", "startup_failure"])
const pending = new Set([
	"queued",
	"in_progress",
	"pending",
	"waiting",
	"requested",
	"running",
	"created",
	"preparing",
	"scheduled",
])

function text(value: unknown): string {
	return typeof value === "string" ? value : ""
}

function rows(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value) || !value.every(object)) throw new Error("The Git provider returned invalid PR data.")
	return value
}

function checkState(value: unknown): PRCheck["state"] {
	if (failed.has(text(value))) return "failed"
	if (pending.has(text(value))) return "pending"
	if (["success", "passed"].includes(text(value))) return "passed"
	if (["neutral", "skipped", "cancelled", "canceled", "manual"].includes(text(value))) return "skipped"
	throw new Error("The Git provider returned an unknown CI state.")
}

export function githubChecks(checks: unknown, statuses: unknown): PRCheck[] {
	return [
		...rows(checks).map((check) => ({
			id: `check:${check.id}:${text(check.completed_at)}`,
			name: text(check.name),
			state: checkState(check.status === "completed" ? check.conclusion : check.status),
			url: text(check.details_url) || null,
			summary: object(check.output) ? text(check.output.summary).slice(0, 4000) : "",
		})),
		...rows(statuses).map((status) => ({
			id: `status:${status.id}`,
			name: text(status.context),
			state: checkState(status.state),
			url: text(status.target_url) || null,
			summary: text(status.description).slice(0, 4000),
		})),
	]
}

export function githubFeedback(threads: unknown, appComments = new Set<number>()): PRFeedback[] {
	return rows(threads).flatMap((thread) => {
		if (thread.isResolved === true || thread.isOutdated === true) return []
		if (!object(thread.comments)) throw new Error("GitHub returned an invalid review thread.")
		const comments = rows(thread.comments.nodes)
		const comment = comments.at(-1)
		if (!comment || !text(comment.body).trim()) return []
		return [
			{
				id: `review:${thread.id}:${comment.id}:${text(comment.updatedAt)}`,
				author: object(comment.author) ? text(comment.author.login) : "",
				body: text(comment.body).slice(0, 8000),
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
		nodes{id isResolved isOutdated comments(last:20){nodes{id databaseId body url updatedAt path line author{login} authorAssociation}}}
		pageInfo{hasNextPage endCursor}
	}}}
}`

async function readGithubFeedback(
	remote: Repository,
	number: number,
	headSha: string,
	signal: AbortSignal,
	deadline: number,
): Promise<PRFeedback[]> {
	const endpoint = api(remote)
	endpoint.pathname = endpoint.pathname.startsWith("/api/v3/") ? "/api/graphql" : "/graphql"
	const [owner, name] = remote.name.split("/")
	const comments = rows(await pages(remote, api(remote, `pulls/${number}/comments?per_page=100`), signal, deadline))
	const appComments = new Set(
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
	const feedback: PRFeedback[] = []
	let after: string | null = null
	for (let page = 0; page < 20; page++) {
		const { value } = await requestJSON(remote, endpoint, signal, deadline, {
			query: reviewQuery,
			variables: { owner, name, number, after },
		})
		if (
			!object(value) ||
			value.errors ||
			!object(value.data) ||
			!object(value.data.repository) ||
			!object(value.data.repository.pullRequest) ||
			!object(value.data.repository.pullRequest.reviewThreads)
		)
			throw new Error("GitHub review threads are unavailable. Check repository permissions.")
		if (value.data.repository.pullRequest.headRefOid !== headSha)
			throw new Error("The PR head changed while checking reviews. Kimchi will check again.")
		const threads = value.data.repository.pullRequest.reviewThreads
		feedback.push(...githubFeedback(threads.nodes, appComments))
		if (!object(threads.pageInfo)) throw new Error("GitHub returned invalid review pagination.")
		if (threads.pageInfo.hasNextPage === false) return feedback
		const next = text(threads.pageInfo.endCursor)
		if (!next || next === after) throw new Error("GitHub returned invalid review pagination.")
		after = next
	}
	throw new Error("This PR has too many review threads to monitor safely.")
}

export async function readPRSnapshot(cwd: string, signal: AbortSignal): Promise<PRSnapshot | null> {
	const lookup = await lookupBranchPullRequest(cwd, signal)
	const pr = lookup?.pullRequest
	if (!pr || !lookup) return null
	const deadline = Date.now() + 25_000
	const remote = await repositoryIdentity(cwd, signal, deadline, new Map(), lookup.branch)
	const get = async (path: string) => (await requestJSON(remote, api(remote, path), signal, deadline)).value
	let checks: PRCheck[]
	let feedback: PRFeedback[]
	if (remote.provider === "github") {
		const [runs, statuses, reviews] = await Promise.all([
			get(`commits/${pr.headSha}/check-runs?per_page=100`),
			get(`commits/${pr.headSha}/status?per_page=100`),
			readGithubFeedback(remote, pr.number, pr.headSha, signal, deadline),
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
		checks = githubChecks(runs.check_runs, statuses.statuses)
		feedback = reviews
	} else {
		const mr = await get(`merge_requests/${pr.number}`)
		if (!object(mr)) throw new Error("GitLab returned an invalid merge request.")
		if (mr.sha !== pr.headSha) throw new Error("The MR head changed while checking CI. Kimchi will check again.")
		const pipeline = object(mr.head_pipeline) ? mr.head_pipeline : null
		const jobs = pipeline
			? rows(await pages(remote, api(remote, `pipelines/${pipeline.id}/jobs?per_page=100`), signal, deadline))
			: []
		checks = jobs.map((job) => ({
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
		const discussions = rows(
			await pages(remote, api(remote, `merge_requests/${pr.number}/discussions?per_page=100`), signal, deadline),
		)
		feedback = []
		const membership = new Map<string, boolean>()
		for (const discussion of discussions) {
			const notes = rows(discussion.notes).filter((note) => note.system !== true)
			const note = notes.at(-1)
			if (note?.resolvable !== true || note.resolved === true || !text(note.body).trim()) continue
			const author = object(note.author) ? note.author : {}
			const id = String(author.id ?? "")
			if (!membership.has(id)) {
				let trusted = false
				if (/^\d+$/.test(id)) {
					try {
						const member = await get(`members/all/${id}`)
						trusted = object(member) && typeof member.access_level === "number" && member.access_level >= 30
					} catch {
						/* Non-members remain visible without authorizing repairs. */
					}
				}
				membership.set(id, trusted)
			}
			const position = object(note.position) ? note.position : {}
			feedback.push({
				id: `review:${discussion.id}:${note.id}:${text(note.updated_at)}`,
				author: text(author.username),
				body: text(note.body).slice(0, 8000),
				url: `${pr.url}#note_${note.id}`,
				path: text(position.new_path) || null,
				line: typeof position.new_line === "number" ? position.new_line : null,
				trusted: membership.get(id) === true,
			})
		}
	}
	return {
		provider: remote.provider,
		repository: remote.name,
		number: pr.number,
		title: pr.title ?? "",
		url: pr.url,
		branch: lookup.branch,
		headSha: pr.headSha,
		state: pr.state,
		checks,
		feedback,
	}
}
