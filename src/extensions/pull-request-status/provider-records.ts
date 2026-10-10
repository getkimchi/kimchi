/** What a GitHub PR or GitLab MR must look like, from a provider response or a saved journal row, and how lookups fail. */
import { plainURL } from "../../utils/url.js"
import { object } from "../work-attribution/summary.js"
import type { WorkPullRequest, WorkPullRequestLookup } from "./pull-requests.js"

export interface Repository {
	provider: "github" | "gitlab"
	host: string
	name: string
	id?: number
	token?: string
}

/** `retry` and `unsupported` failures are expected; they never need the user's attention. */
export class LookupError extends Error {
	constructor(
		message: string,
		readonly kind?: "missing" | "invalid" | "retry" | "unsupported",
		/** The provider's own API error format, which proves an unconfigured host runs that provider. */
		readonly fromProvider = false,
	) {
		super(message)
	}
}

export function lookupFailureReason(error: unknown): WorkPullRequestLookup["reason"] {
	if (!(error instanceof LookupError)) return undefined
	if (error.kind === "retry" || error.kind === "invalid") return "retry"
	return error.kind === "unsupported" ? "unsupported" : undefined
}

export const SHA = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i

export function timestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value))
}

export function nullableTimestamp(value: unknown): value is string | null {
	return value === null || timestamp(value)
}

export function providerId(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value)
	if (typeof value === "string" && /^[1-9]\d{0,19}$/.test(value)) return value
}

export function httpsURL(value: unknown): URL {
	const url = plainURL(value)
	if (url) return url
	throw new LookupError("The Git provider returned an invalid URL.", "invalid")
}

export function repositoryPath(value: unknown, provider?: Repository["provider"]): value is string {
	if (typeof value !== "string") return false
	const segments = value.split("/")
	return (
		segments.length >= 2 &&
		(provider !== "github" || segments.length === 2) &&
		segments.every((segment) => /^[\w.-]+$/.test(segment) && segment !== "." && segment !== "..")
	)
}

export function label(repository: Pick<Repository, "provider">): string {
	return repository.provider === "gitlab" ? "GitLab" : "GitHub"
}

export function pullRequest(
	value: unknown,
	repository: Pick<Repository, "host" | "provider">,
	checkedAt: string,
): WorkPullRequest {
	const { host, provider } = repository
	if (!object(value)) throw new LookupError(`${label(repository)} returned an invalid pull request.`, "invalid")
	const validStates = provider === "gitlab" ? ["opened", "locked", "closed", "merged"] : ["open", "closed"]
	if (typeof value.state !== "string" || !validStates.includes(value.state))
		throw new LookupError(`${label(repository)} returned an invalid pull request state.`, "invalid")
	const number = provider === "gitlab" ? value.iid : value.number
	const headSha = provider === "gitlab" ? value.sha : object(value.head) ? value.head.sha : undefined
	const mergedAt = provider === "gitlab" ? (value.merged_at ?? null) : value.merged_at
	const closedAt = provider === "gitlab" ? (value.closed_at ?? null) : value.closed_at
	const state =
		provider === "gitlab"
			? value.state === "opened" || value.state === "locked"
				? "open"
				: value.state
			: mergedAt
				? "merged"
				: value.state
	if (
		!Number.isSafeInteger(number) ||
		typeof number !== "number" ||
		number < 1 ||
		(state !== "open" && state !== "closed" && state !== "merged") ||
		typeof headSha !== "string" ||
		!SHA.test(headSha) ||
		(value.merge_commit_sha !== null &&
			(typeof value.merge_commit_sha !== "string" || !SHA.test(value.merge_commit_sha))) ||
		!nullableTimestamp(mergedAt) ||
		!nullableTimestamp(closedAt)
	)
		throw new LookupError(`${label(repository)} returned an invalid pull request.`, "invalid")
	const url = httpsURL(provider === "gitlab" ? value.web_url : value.html_url)
	const id = providerId(value.id)
	const repositoryId = providerId(
		provider === "gitlab"
			? value.target_project_id
			: object(value.base) && object(value.base.repo)
				? value.base.repo.id
				: undefined,
	)

	const path = (provider === "gitlab" ? /^\/(.+)\/-\/merge_requests\/(\d+)$/ : /^\/(.+)\/pull\/(\d+)$/).exec(
		url.pathname,
	)
	if (url.host !== host || !path || Number(path[2]) !== number || !repositoryPath(path[1], provider))
		throw new LookupError(`${label(repository)} returned a pull request from an unexpected repository.`, "invalid")
	return {
		provider,
		...(id ? { id } : {}),
		...(repositoryId ? { repositoryId } : {}),
		url: url.href,
		number,
		state,
		repository: path[1],
		host,
		headSha,
		mergeCommitSha: value.merge_commit_sha,
		mergedAt,
		closedAt,
		checkedAt,
	}
}

export function storedPullRequests(value: unknown): WorkPullRequest[] {
	if (!Array.isArray(value)) return []
	return value.flatMap((item) => {
		if (!object(item) || typeof item.host !== "string" || !timestamp(item.checkedAt)) return []
		const provider = item.provider ?? "github"
		if (provider !== "github" && provider !== "gitlab") return []
		try {
			return [
				pullRequest(
					{
						id: item.id,
						base: { repo: { id: item.repositoryId } },
						target_project_id: item.repositoryId,
						html_url: item.url,
						web_url: item.url,
						number: item.number,
						iid: item.number,
						state:
							provider === "gitlab"
								? item.state === "open"
									? "opened"
									: item.state
								: item.state === "merged"
									? "closed"
									: item.state,
						head: { sha: item.headSha },
						sha: item.headSha,
						merge_commit_sha: item.mergeCommitSha,
						merged_at: item.mergedAt,
						closed_at: item.closedAt,
					},
					{ host: item.host, provider },
					item.checkedAt,
				),
			]
		} catch {
			return []
		}
	})
}
