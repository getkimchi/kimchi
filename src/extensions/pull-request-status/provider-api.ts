/** GitHub and GitLab access for PR discovery: credentials, the bounded HTTP client with pagination, and repository identity. */
import { execFile } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { readGitToken } from "../../config.js"
import { object } from "../work-attribution/summary.js"
import { httpsURL, LookupError, label, providerId, type Repository, repositoryPath } from "./provider-records.js"

const COMMAND_TIMEOUT_MS = 5000

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

const cooldowns = new Map<string, number>()

const sshHosts = new Map<string, string>()

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

export function command(
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

export async function credential(
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

export function api(repository: Pick<Repository, "host" | "provider" | "name">, endpoint = ""): URL {
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

export async function requestJSON(
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

export async function pages(
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
		// GitLab's own page counter comes first: its Link header also repeats route parameters and adds defaulted
		// filters, such as with_labels_details, that the request never sent.
		const nextPage = result.headers.get("x-next-page")
		const link = nextPage ? undefined : /<([^>]+)>;\s*rel="?next"?/.exec(result.headers.get("link") ?? "")?.[1]
		if (!link && !nextPage) return values
		let next: URL
		try {
			next = link ? new URL(link, result.url) : new URL(result.url)
		} catch {
			throw new LookupError("The Git provider returned invalid pagination.")
		}
		if (nextPage) next.searchParams.set("page", nextPage)
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

export async function repositoryIdentity(
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

/** A captured request's repository identity gets at most this long; the caller's signal usually ends it sooner. */
const IDENTITY_BUDGET_MS = 10_000

/** Provider identity for captured unlinked requests; credentials stay inside discovery. */
export async function lookupRepositoryIdentity(
	cwd: string,
	signal: AbortSignal,
	tokens: Parameters<typeof repositoryIdentity>[3] = new Map(),
): Promise<{ provider: "github" | "gitlab"; host: string; name: string; id: string }> {
	const repository = await repositoryIdentity(cwd, signal, Date.now() + IDENTITY_BUDGET_MS, tokens)
	const id = providerId(repository.id)
	if (!id) throw new LookupError("The Git provider returned no stable repository ID.", "invalid")
	return { provider: repository.provider, host: repository.host, name: repository.name, id }
}
