/** What a GitHub PR or GitLab MR must look like in a provider response, and how lookups fail. */
import { plainURL } from "../../utils/url.js"

export interface Repository {
	provider: "github" | "gitlab"
	host: string
	name: string
	id?: number
	token?: string
}

/** A PR or MR as the footer names and links it. */
export interface PullRequestLink {
	provider: "github" | "gitlab"
	number: number
	state: "open" | "closed" | "merged"
	url: string
	/** The repository path in the URL, such as `owner/repo`. */
	repository: string
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

/** A failure the user cannot act on: a retryable outage, or a repository without a supported provider. */
export function lookupFailureReason(error: unknown): "retry" | "unsupported" | undefined {
	if (!(error instanceof LookupError)) return undefined
	if (error.kind === "retry" || error.kind === "invalid") return "retry"
	return error.kind === "unsupported" ? "unsupported" : undefined
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nullableTimestamp(value: unknown): value is string | null {
	return value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)))
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

/** `PR #7 open` or `MR !7 merged`, as the footer names a link; it drops the state when space runs out. */
export function pullRequestLabel(pr: Pick<PullRequestLink, "provider" | "number" | "state">): string {
	return `${pr.provider === "gitlab" ? "MR !" : "PR #"}${pr.number} ${pr.state}`
}

/** A provider's PR or MR, rejected unless it is a well-formed link into a repository on the queried host. */
export function pullRequest(value: unknown, repository: Pick<Repository, "host" | "provider">): PullRequestLink {
	const { host, provider } = repository
	if (!isRecord(value)) throw new LookupError(`${label(repository)} returned an invalid pull request.`, "invalid")
	const validStates = provider === "gitlab" ? ["opened", "locked", "closed", "merged"] : ["open", "closed"]
	if (typeof value.state !== "string" || !validStates.includes(value.state))
		throw new LookupError(`${label(repository)} returned an invalid pull request state.`, "invalid")
	const number = provider === "gitlab" ? value.iid : value.number
	const mergedAt = provider === "gitlab" ? (value.merged_at ?? null) : value.merged_at
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
		!nullableTimestamp(mergedAt)
	)
		throw new LookupError(`${label(repository)} returned an invalid pull request.`, "invalid")
	const url = httpsURL(provider === "gitlab" ? value.web_url : value.html_url)
	const path = (provider === "gitlab" ? /^\/(.+)\/-\/merge_requests\/(\d+)$/ : /^\/(.+)\/pull\/(\d+)$/).exec(
		url.pathname,
	)
	if (url.host !== host || !path || Number(path[2]) !== number || !repositoryPath(path[1], provider))
		throw new LookupError(`${label(repository)} returned a pull request from an unexpected repository.`, "invalid")
	return { provider, number, state, url: url.href, repository: path[1] }
}
