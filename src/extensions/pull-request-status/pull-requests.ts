import { execFile } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { readGitToken } from "../../config.js"
import { readWorkRecords } from "../work-attribution/summary.js"
import { appendWorkRecord } from "../work-attribution.js"
import { mergePullRequestLinks as mergePullRequests, pullRequestKey } from "./links.js"

const PASS_BUDGET_MS = 10_000
const COMMAND_TIMEOUT_MS = 5000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MTIME_SLACK_MS = 2000
const DAY_MS = 24 * 60 * 60 * 1000
/** Failures saved before this process started are retried once, so a fixed token need not wait out the backoff. */
const PROCESS_STARTED = Date.now()
const SHA = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i

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
interface Repository {
	provider: "github" | "gitlab"
	host: string
	name: string
	id?: number
	token?: string
}
const states = new Map<string, DiscoveryState>()
const cooldowns = new Map<string, number>()
const sshHosts = new Map<string, string>()

function discoveryState(directory: string): DiscoveryState {
	const state = states.get(directory) ?? { commits: new Map<string, WorkPullRequestUpdate>() }
	states.set(directory, state)
	return state
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
function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}
function timestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value))
}
function nullableTimestamp(value: unknown): value is string | null {
	return value === null || timestamp(value)
}
function providerId(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value)
	if (typeof value === "string" && /^[1-9]\d{0,19}$/.test(value)) return value
}
function httpsURL(value: unknown): URL {
	if (typeof value === "string") {
		try {
			const url = new URL(value)
			if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash) return url
		} catch {}
	}
	throw new LookupError("The Git provider returned an invalid URL.", "invalid")
}
function repositoryPath(value: unknown, provider?: Repository["provider"]): value is string {
	if (typeof value !== "string") return false
	const segments = value.split("/")
	return (
		segments.length >= 2 &&
		(provider !== "github" || segments.length === 2) &&
		segments.every((segment) => /^[\w.-]+$/.test(segment) && segment !== "." && segment !== "..")
	)
}
function label(repository: Pick<Repository, "provider">): string {
	return repository.provider === "gitlab" ? "GitLab" : "GitHub"
}
function pullRequest(
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
function storedPullRequests(value: unknown): WorkPullRequest[] {
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
/** Checks slow down in proportion to a commit's age: new pushes link on the next pass, old commits at most daily, and pending ones stop after the upload window. */
function lookupDue(commits: WorkPullRequestUpdate[], now = Date.now()): boolean {
	let latest: WorkPullRequestLookup | undefined
	for (const { prLookup } of commits) {
		if (!prLookup) return true
		if (!latest || Date.parse(prLookup.checkedAt) > Date.parse(latest.checkedAt)) latest = prLookup
	}
	if (!latest) return true
	if (latest.error && !latest.reason && Date.parse(latest.checkedAt) < PROCESS_STARTED) return true
	const age = now - Math.min(...commits.map((commit) => Date.parse(commit.recordedAt ?? "") || now))
	if (latest.status === "pending" && age > 32 * DAY_MS) return false
	return now - Date.parse(latest.checkedAt) >= Math.min(DAY_MS, age / 16)
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
function cliEnvironment(): NodeJS.ProcessEnv {
	const env = { ...process.env }
	for (const key of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_COMMON_DIR",
		"GIT_INDEX_FILE",
		"GH_REPO",
		"GH_HOST",
		"GLAB_REPO",
		"GITLAB_HOST",
		"GL_HOST",
		"GITLAB_URI",
		"GH_TOKEN",
		"GITHUB_TOKEN",
		"GH_ENTERPRISE_TOKEN",
		"GITHUB_ENTERPRISE_TOKEN",
		"GITLAB_TOKEN",
		"GLAB_TOKEN",
		"GITLAB_ACCESS_TOKEN",
		"OAUTH_TOKEN",
	])
		delete env[key]
	return {
		...env,
		GH_PROMPT_DISABLED: "1",
		GH_NO_UPDATE_NOTIFIER: "1",
		GH_TELEMETRY: "false",
		GLAB_NO_PROMPT: "true",
		GLAB_SEND_TELEMETRY: "false",
		GLAB_ENABLE_CI_AUTOLOGIN: "false",
		GLAB_CHECK_UPDATE: "false",
		GLAB_SHOW_WHATS_NEW: "false",
	}
}
function command(
	command: string,
	args: string[],
	cwd: string | undefined,
	signal: AbortSignal,
	deadline: number,
	environment: NodeJS.ProcessEnv = {},
): Promise<string | undefined> {
	signal.throwIfAborted()
	const remaining = deadline - Date.now()
	if (remaining <= 0) throw new LookupError("Git provider lookup timed out. Kimchi will retry.", "retry")
	return new Promise((done, reject) => {
		execFile(
			command,
			args,
			{
				cwd,
				env: { ...cliEnvironment(), ...environment },
				signal,
				encoding: "utf8",
				timeout: Math.min(COMMAND_TIMEOUT_MS, remaining),
				maxBuffer: 64 * 1024,
			},
			(error, stdout) => {
				if (signal.aborted) reject(signal.reason)
				else done(error ? undefined : stdout.trim() || undefined)
			},
		)
	})
}
function configuredHost(value: string | undefined): string | undefined {
	if (!value) return undefined
	try {
		const url = httpsURL(value.includes("://") ? value : `https://${value}`)
		return url.pathname === "/" ? url.host : undefined
	} catch {
		return undefined
	}
}
function gitlabHost(): string | undefined {
	// An explicit but invalid host must not send its token to the cloud default.
	return configuredHost(process.env.GITLAB_HOST ?? process.env.GL_HOST ?? process.env.GITLAB_URI ?? "gitlab.com")
}
function environmentToken(repository: Pick<Repository, "provider" | "host">): string | undefined {
	if (repository.provider === "github") {
		if (repository.host === "github.com") return process.env.GH_TOKEN || process.env.GITHUB_TOKEN
		if (repository.host === configuredHost(process.env.GH_HOST))
			return process.env.GH_ENTERPRISE_TOKEN || process.env.GITHUB_ENTERPRISE_TOKEN
	} else if (repository.host === gitlabHost()) {
		return process.env.GITLAB_TOKEN || process.env.GLAB_TOKEN || process.env.GITLAB_ACCESS_TOKEN
	}
	return undefined
}
async function gitlabCredential(host: string, signal: AbortSignal, deadline: number): Promise<string | undefined> {
	const path = await command("glab", ["config", "path"], undefined, signal, deadline)
	if (!path || !isAbsolute(path)) return undefined
	let entry: unknown
	try {
		const file = statSync(path)
		if (!file.isFile() || file.size > 64 * 1024) return undefined
		const config: unknown = parseYaml(readFileSync(path, "utf8"), { logLevel: "silent", maxAliasCount: 0 })
		if (!object(config) || !object(config.hosts) || !Object.hasOwn(config.hosts, host)) return undefined
		entry = config.hosts[host]
	} catch {
		return undefined
	}
	if (!object(entry)) return undefined
	// glab's token command can fall back to an unrelated global or local token.
	// Plaintext credentials must be stored under this exact host.
	if (entry.use_keyring !== true && entry.use_keyring !== "true")
		return typeof entry.token === "string" ? entry.token.trim() || undefined : undefined
	let directory: string | undefined
	try {
		directory = mkdtempSync(join(tmpdir(), "kimchi-glab-auth-"))
		writeFileSync(join(directory, "config.yml"), stringifyYaml({ hosts: { [host]: { use_keyring: "true" } } }), {
			mode: 0o600,
		})
		// Let glab use its host-bound keyring service with no global/local token fallback.
		return await command("glab", ["config", "get", "token", "--host", host], directory, signal, deadline, {
			GLAB_CONFIG_DIR: directory,
			GIT_DIR: join(directory, ".git"),
		})
	} finally {
		if (directory) rmSync(directory, { recursive: true, force: true })
	}
}
async function credential(
	repository: Pick<Repository, "provider" | "host">,
	signal: AbortSignal,
	deadline: number,
	tokens: Map<string, Promise<string | undefined>>,
): Promise<string | undefined> {
	const key = `${repository.provider}:${repository.host}`
	let token = tokens.get(key)
	if (!token) {
		token = (async () =>
			environmentToken(repository) ||
			readGitToken(repository.host) ||
			(await (repository.provider === "github"
				? command("gh", ["auth", "token", "--hostname", repository.host], undefined, signal, deadline)
				: gitlabCredential(repository.host, signal, deadline))))()
		tokens.set(key, token)
	}
	return token
}
function api(repository: Pick<Repository, "host" | "provider" | "name">, endpoint = ""): URL {
	const base =
		repository.provider === "gitlab"
			? `https://${repository.host}/api/v4/projects/${encodeURIComponent(repository.name)}`
			: `${repository.host === "github.com" ? "https://api.github.com" : `https://${repository.host}/api/v3`}/repos/${repository.name}`
	return new URL(`${base}${endpoint ? `/${endpoint}` : ""}`)
}
function rateLimitUntil(headers: Headers, status: number): number | undefined {
	const now = Date.now()
	const retry = headers.get("retry-after")
	const retryTime = retry ? (/^\d+(?:\.\d+)?$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry)) : 0
	const exhausted = headers.get("x-ratelimit-remaining") === "0" || headers.get("ratelimit-remaining") === "0"
	const reset = exhausted ? Number(headers.get("x-ratelimit-reset") ?? headers.get("ratelimit-reset")) * 1000 : 0
	const until = Math.max(Number.isFinite(retryTime) ? retryTime : 0, Number.isFinite(reset) ? reset : 0)
	return until > now ? until : status === 429 || exhausted ? now + 60_000 : undefined
}
function sameOrigin(url: URL, origin: string): void {
	if (url.origin !== origin || url.username || url.password || url.hash)
		throw new LookupError("The Git provider returned an unsafe redirect or pagination URL.")
}
async function requestJSON(
	repository: Repository,
	initialURL: URL,
	signal: AbortSignal,
	deadline: number,
): Promise<{
	value: unknown
	headers: Headers
	url: URL
	bytes: number
}> {
	signal.throwIfAborted()
	const origin = api(repository).origin
	sameOrigin(initialURL, origin)
	if ((cooldowns.get(origin) ?? 0) > Date.now())
		throw new LookupError(`${label(repository)} rate limit reached. Kimchi will retry after the limit resets.`, "retry")
	const remaining = Math.min(COMMAND_TIMEOUT_MS, deadline - Date.now())
	if (remaining <= 0) throw new LookupError(`${label(repository)} lookup timed out. Kimchi will retry.`, "retry")
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), remaining)
	const requestSignal = AbortSignal.any([signal, controller.signal])
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
	const abortBody = () => {
		void reader?.cancel().catch(() => {})
	}
	requestSignal.addEventListener("abort", abortBody, { once: true })
	try {
		let url = initialURL
		for (let redirects = 0; ; redirects++) {
			sameOrigin(url, origin)
			const response = await fetch(url, {
				method: "GET",
				redirect: "manual",
				signal: requestSignal,
				headers: {
					Accept: "application/json",
					"User-Agent": "Kimchi",
					...(repository.token ? { Authorization: `Bearer ${repository.token}` } : {}),
				},
			})
			const limitedUntil = rateLimitUntil(response.headers, response.status)
			if (limitedUntil) cooldowns.set(origin, limitedUntil)
			if ([301, 302, 303, 307, 308].includes(response.status)) {
				await response.body?.cancel()
				const location = response.headers.get("location")
				if (!location || redirects === 3)
					throw new LookupError(`${label(repository)} returned too many or invalid redirects.`)
				url = new URL(location, url)
				sameOrigin(url, origin)
				if (limitedUntil)
					throw new LookupError(
						`${label(repository)} rate limit reached. Kimchi will retry after the limit resets.`,
						"retry",
					)
				continue
			}
			// Only a commit-association endpoint can report an unpublished commit.
			// Inspect its bounded body; repository and permission errors stay errors.
			const missingCommitSha =
				repository.provider === "github" && response.status === 422
					? /^\/(?:api\/v3\/)?(?:repos\/[^/]+\/[^/]+|repositories\/\d+)\/commits\/([a-f\d]{40}|[a-f\d]{64})\/pulls$/i.exec(
							url.pathname,
						)?.[1]
					: repository.provider === "gitlab" && response.status === 404
						? /^\/api\/v4\/projects\/[^/]+\/repository\/commits\/([a-f\d]{40}|[a-f\d]{64})\/merge_requests$/i.exec(
								url.pathname,
							)?.[1]
						: undefined
			if (!response.ok && limitedUntil) {
				await response.body?.cancel()
				throw new LookupError(
					`${label(repository)} rate limit reached. Kimchi will retry after the limit resets.`,
					"retry",
				)
			}
			if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
				await response.body?.cancel()
				throw new LookupError(`${label(repository)} response exceeded the lookup limit.`)
			}
			reader = response.body?.getReader()
			const chunks: Uint8Array[] = []
			let bytes = 0
			while (reader) {
				requestSignal.throwIfAborted()
				const chunk = await reader.read()
				if (chunk.done) break
				bytes += chunk.value.byteLength
				if (bytes > MAX_RESPONSE_BYTES) {
					await reader.cancel()
					throw new LookupError(`${label(repository)} response exceeded the lookup limit.`)
				}
				chunks.push(chunk.value)
			}
			requestSignal.throwIfAborted()
			let value: unknown
			try {
				value = JSON.parse(Buffer.concat(chunks).toString("utf8"))
			} catch {
				if (response.ok || missingCommitSha)
					throw new LookupError(`${label(repository)} returned invalid JSON.`, "invalid")
			}
			if (!response.ok && !missingCommitSha) {
				// GitHub errors link their documentation; GitLab messages start with the HTTP status,
				// and its token errors use OAuth's error fields.
				const fromProvider =
					object(value) &&
					(repository.provider === "github"
						? typeof value.documentation_url === "string"
						: (typeof value.message === "string" && value.message.startsWith(`${response.status} `)) ||
							(typeof value.error === "string" && typeof value.error_description === "string"))
				if (response.status === 401)
					throw new LookupError(
						`${label(repository)} authentication failed. Check the token for ${repository.host}.`,
						undefined,
						fromProvider,
					)
				if (response.status === 403)
					throw new LookupError(
						`${label(repository)} denied access. Check repository permissions for ${repository.host}.`,
						undefined,
						fromProvider,
					)
				if (response.status === 404)
					throw new LookupError(
						`${label(repository)} could not find this repository, commit or pull request. It may require authentication.`,
						"missing",
						fromProvider,
					)
				throw new LookupError(
					`${label(repository)} lookup failed (HTTP ${response.status}). Kimchi will retry.`,
					"retry",
					fromProvider,
				)
			}
			if (missingCommitSha) {
				const message =
					repository.provider === "github" ? `No commit found for SHA: ${missingCommitSha}` : "404 Commit Not Found"
				if (!object(value) || value.message !== message)
					throw new LookupError(
						`${label(repository)} lookup failed (HTTP ${response.status}). Kimchi will retry.`,
						response.status === 404 ? "missing" : "retry",
					)
				value = []
			}
			return { value, headers: response.headers, url, bytes }
		}
	} catch (error) {
		signal.throwIfAborted()
		if (controller.signal.aborted)
			throw new LookupError(`${label(repository)} lookup timed out. Kimchi will retry.`, "retry")
		if (error instanceof LookupError) throw error
		throw new LookupError(`${label(repository)} lookup failed. Check network and repository access.`, "retry")
	} finally {
		clearTimeout(timeout)
		requestSignal.removeEventListener("abort", abortBody)
		reader?.releaseLock()
	}
}
async function pages(
	repository: Repository,
	initialURL: URL,
	signal: AbortSignal,
	deadline: number,
): Promise<unknown[]> {
	let url = initialURL
	const values: unknown[] = []
	let bytes = 0
	for (let page = 0; page < 100; page++) {
		const result = await requestJSON(repository, url, signal, deadline)
		bytes += result.bytes
		if (bytes > MAX_RESPONSE_BYTES) throw new LookupError(`${label(repository)} response exceeded the lookup limit.`)
		if (!Array.isArray(result.value))
			throw new LookupError(`${label(repository)} returned invalid pull request pages.`, "invalid")
		values.push(...result.value)
		const link = /<([^>]+)>;\s*rel="?next"?/.exec(result.headers.get("link") ?? "")?.[1]
		const nextPage = result.headers.get("x-next-page")
		if (!link && !nextPage) return values
		let next: URL
		try {
			next = link ? new URL(link, result.url) : new URL(result.url)
		} catch {
			throw new LookupError("The Git provider returned invalid pagination.")
		}
		if (!link && nextPage) next.searchParams.set("page", nextPage)
		sameOrigin(next, initialURL.origin)
		const pageNumber = next.searchParams.get("page") ?? ""
		const numericRoute = /^\/(?:api\/v3\/)?repositories\/([1-9]\d*)(\/.+)$/.exec(next.pathname)
		const sameRepositoryRoute =
			repository.provider === "github" &&
			numericRoute &&
			(repository.id === undefined || String(repository.id) === numericRoute[1]) &&
			next.pathname === result.url.pathname.replace(/\/repos\/[^/]+\/[^/]+(?=\/)/, `/repositories/${numericRoute[1]}`)
		if (
			(next.pathname !== result.url.pathname && !sameRepositoryRoute) ||
			!/^[1-9]\d*$/.test(pageNumber) ||
			!Number.isSafeInteger(Number(pageNumber)) ||
			next.searchParams.getAll("page").length !== 1 ||
			Number(pageNumber) <= Number(url.searchParams.get("page") ?? 1)
		)
			throw new LookupError("The Git provider returned invalid pagination.")
		if (repository.provider === "gitlab") {
			const routeId = /^\/api\/v4\/projects\/([^/]+)(?:\/|$)/.exec(result.url.pathname)?.[1]
			const routeSha = /\/repository\/commits\/([^/]+)\//.exec(result.url.pathname)?.[1]
			for (const [key, value] of Object.entries({ id: routeId, sha: routeSha }))
				if (
					value &&
					next.searchParams.getAll(key).length === 1 &&
					next.searchParams.get(key) === decodeURIComponent(value)
				)
					next.searchParams.delete(key)
		}
		for (const key of new Set([...result.url.searchParams.keys(), ...next.searchParams.keys()]))
			if (key !== "page" && result.url.searchParams.get(key) !== next.searchParams.get(key))
				throw new LookupError("The Git provider changed the pagination query.")
		url = new URL(result.url)
		url.pathname = next.pathname
		url.searchParams.set("page", pageNumber)
	}
	throw new LookupError("The Git provider returned too many pages.")
}
function remoteRepository(value: string): Pick<Repository, "host" | "name"> & { ssh: boolean } {
	const shorthand = /^[\w.-]+@([\w.-]+):(.+)$/.exec(value)
	let url: URL
	try {
		url = new URL(shorthand ? `https://${shorthand[1]}/${shorthand[2]}` : value)
	} catch {
		throw new LookupError("This repository has no supported GitHub or GitLab remote.", "unsupported")
	}
	if ((url.protocol !== "https:" && url.protocol !== "ssh:") || url.search || url.hash)
		throw new LookupError("This repository has no supported GitHub or GitLab remote.", "unsupported")
	const name = url.pathname
		.replace(/^\//, "")
		.replace(/\.git\/?$/, "")
		.replace(/\/$/, "")
	if (!repositoryPath(name)) throw new LookupError("This repository has an invalid Git remote path.", "unsupported")
	const ssh = Boolean(shorthand) || url.protocol === "ssh:"
	return { host: ssh ? url.hostname : url.host, name, ssh }
}
function providerFor(host: string): Repository["provider"] | undefined {
	if (host === "github.com" || host === configuredHost(process.env.GH_HOST)) return "github"
	if (host === "gitlab.com" || host === gitlabHost()) return "gitlab"
}
/** Resolves a ~/.ssh/config alias such as `github-work` without connecting. */
async function sshHostName(alias: string, signal: AbortSignal, deadline: number): Promise<string> {
	const cached = sshHosts.get(alias)
	if (cached || alias.startsWith("-")) return cached ?? alias
	const host = /^hostname ([\w.-]+)$/m.exec(
		(await command("ssh", ["-G", alias], undefined, signal, deadline)) ?? "",
	)?.[1]
	if (host) sshHosts.set(alias, host)
	return host ?? alias
}
async function repositoryIdentity(
	path: string,
	signal: AbortSignal,
	deadline: number,
	tokens: Map<string, Promise<string | undefined>>,
	branch?: string,
): Promise<Repository> {
	if (!existsSync(path)) throw new LookupError("The local Git repository is unavailable.", "unsupported")
	const config = await command(
		"git",
		["-C", path, "config", "--get-regexp", "^(remote\\..*\\.url|branch\\..*\\.remote)$"],
		path,
		signal,
		deadline,
	)
	const entries = new Map(
		(config ?? "").split("\n").flatMap((line) => {
			const entry = /^(\S+)\s+(.+)$/.exec(line)
			return entry ? [[entry[1], entry[2]]] : []
		}),
	)
	const remotes = [...entries].filter(([key]) => /^remote\..+\.url$/.test(key))
	const upstream = branch ? entries.get(`branch.${branch}.remote`) : undefined
	const selected =
		(upstream && entries.get(`remote.${upstream}.url`)) ||
		entries.get("remote.origin.url") ||
		(remotes.length === 1 ? remotes[0][1] : undefined)
	if (!selected) throw new LookupError("This repository has no unambiguous GitHub or GitLab remote.", "unsupported")
	const { ssh, ...remote } = remoteRepository(selected)
	if (ssh && !providerFor(remote.host)) {
		// Follow an alias only to a known provider; another SSH address need not serve the HTTPS API.
		const resolved = await sshHostName(remote.host, signal, deadline)
		if (providerFor(resolved)) remote.host = resolved
	}
	const provider = providerFor(remote.host)
	const candidates: Repository["provider"][] = provider ? [provider] : ["github", "gitlab"]
	const saved = provider ? undefined : readGitToken(remote.host)
	for (const candidate of candidates) {
		if (!repositoryPath(remote.name, candidate)) continue
		const repository: Repository = { ...remote, provider: candidate }
		repository.token = saved || (await credential(repository, signal, deadline, tokens))
		try {
			const { value } = await requestJSON(repository, api(repository), signal, deadline)
			const name = object(value) ? (candidate === "github" ? value.full_name : value.path_with_namespace) : undefined
			const url = httpsURL(object(value) ? (candidate === "github" ? value.html_url : value.web_url) : undefined)
			if (!repositoryPath(name, candidate) || url.host !== remote.host || url.pathname !== `/${name}`)
				throw new LookupError(`${label(repository)} returned an invalid repository.`, "invalid")
			const id = object(value) ? value.id : undefined
			if (candidate === "gitlab" && (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0))
				throw new LookupError("GitLab returned an invalid project ID.", "invalid")
			return { ...repository, name, ...(typeof id === "number" ? { id } : {}) }
		} catch (error) {
			// Unknown self-hosts can probe both API shapes with the same saved identity. Only the provider's own
			// error identifies the host; sign-in pages, redirects and network failures mean an unsupported remote.
			// A rejected CLI identity must never fall through to another account/provider.
			if (provider || (repository.token && !saved) || !(error instanceof LookupError) || error.fromProvider) throw error
		}
	}
	throw new LookupError("This repository has no supported GitHub or GitLab API.", "unsupported")
}

export interface BranchPullRequest {
	branch: string
	pullRequest?: WorkPullRequest
}
async function currentBranch(cwd: string, signal: AbortSignal, deadline: number): Promise<string | undefined> {
	return command(
		"git",
		["-C", cwd, "symbolic-ref", "--quiet", "--short", "HEAD"],
		cwd,
		signal,
		Math.min(deadline, Date.now() + 2000),
	)
}
/** A branch status check has no work identity, ledger, summary, or attribution side effects. */
export async function lookupBranchPullRequest(
	cwd: string,
	signal: AbortSignal,
	onBranch?: (branch: string | undefined) => void,
): Promise<BranchPullRequest | undefined> {
	const deadline = Date.now() + PASS_BUDGET_MS
	const branch = await currentBranch(cwd, signal, deadline)
	onBranch?.(branch)
	if (!branch) return undefined
	let pull: WorkPullRequest | undefined
	let failure: unknown
	try {
		const remote = await repositoryIdentity(cwd, signal, deadline, new Map(), branch)
		const url = api(remote, remote.provider === "github" ? "pulls" : "merge_requests")
		url.search = new URLSearchParams(
			remote.provider === "github"
				? {
						state: "all",
						head: `${remote.name.split("/")[0]}:${branch}`,
						sort: "updated",
						direction: "desc",
						per_page: "1",
					}
				: { scope: "all", state: "all", source_branch: branch, order_by: "updated_at", sort: "desc", per_page: "100" },
		).toString()
		const values =
			remote.provider === "gitlab"
				? await pages(remote, url, signal, deadline)
				: (await requestJSON(remote, url, signal, deadline)).value
		if (!Array.isArray(values)) throw new LookupError(`${label(remote)} returned invalid pull requests.`)
		const value =
			remote.provider === "gitlab"
				? values.find(
						(value) => object(value) && value.source_project_id === remote.id && value.source_branch === branch,
					)
				: values[0]
		if (value !== undefined) {
			const head = object(value)
				? remote.provider === "gitlab"
					? value.source_branch
					: object(value.head)
						? value.head.ref
						: undefined
				: undefined
			if (head !== branch) throw new LookupError(`${label(remote)} returned a pull request for a different branch.`)
			pull = pullRequest(value, remote, new Date().toISOString())
		}
	} catch (error) {
		failure = error
	}
	// Ignore a result for a branch that was checked out while the provider was responding.
	if ((await currentBranch(cwd, signal, Date.now() + 2000)) !== branch) return undefined
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
		if (!lookupDue(commits)) continue
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
