import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { type ExtensionToolContext, getAgentDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent"
import { quote } from "shell-quote"
import { resolvePreMainProjectTrust } from "../../project-trust.js"
import { api, credential, pages, requestJSON } from "../pull-request-status/provider-api.js"
import { pullRequest, type Repository, repositoryPath, SHA } from "../pull-request-status/provider-records.js"
import { object } from "../work-attribution/summary.js"

export function parsePRTarget(value: string): { url: string; repository: Repository; number: number } {
	const url = new URL(value)
	if (url.protocol !== "https:" || url.username || url.password)
		throw new Error("Use an HTTPS PR URL without credentials.")
	const github = /^\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname)
	const gitlab = /^\/(.+)\/-\/merge_requests\/([1-9]\d*)\/?$/.exec(url.pathname)
	const match = github ?? gitlab
	const provider = github ? "github" : "gitlab"
	if (!match || !repositoryPath(match[1], provider) || !Number.isSafeInteger(Number(match[2])))
		throw new Error("Use a GitHub PR or GitLab merge request URL.")
	url.search = ""
	url.hash = ""
	return {
		url: url.href.replace(/\/$/, ""),
		repository: { provider, host: url.host, name: match[1] },
		number: Number(match[2]),
	}
}

export async function readPRTarget(value: string, signal: AbortSignal) {
	const target = parsePRTarget(value)
	const remote = target.repository
	const deadline = Date.now() + 25_000
	remote.token = await credential(remote, signal, deadline, new Map())
	const { value: record } = await requestJSON(
		remote,
		api(remote, `${remote.provider === "github" ? "pulls" : "merge_requests"}/${target.number}`),
		signal,
		deadline,
	)
	const pr = pullRequest(record, remote, new Date().toISOString())
	if (pr.number !== target.number || pr.url !== target.url || !object(record))
		throw new Error("The provider returned a different PR.")
	let source: unknown
	let branch: unknown
	if (remote.provider === "github") {
		branch = object(record.head) ? record.head.ref : undefined
		source = object(record.head) && object(record.head.repo) ? record.head.repo.clone_url : undefined
	} else {
		branch = record.source_branch
		if (typeof record.source_project_id !== "number" || !Number.isSafeInteger(record.source_project_id))
			throw new Error("The MR source project is unavailable.")
		const sourceURL = new URL(`/api/v4/projects/${record.source_project_id}`, `https://${remote.host}`)
		const { value: project } = await requestJSON(remote, sourceURL, signal, deadline)
		source = object(project) ? project.http_url_to_repo : undefined
	}
	const sourceURL = typeof source === "string" ? new URL(source) : undefined
	if (
		sourceURL?.protocol !== "https:" ||
		sourceURL.host !== remote.host ||
		sourceURL.username ||
		sourceURL.password ||
		sourceURL.search ||
		sourceURL.hash ||
		!repositoryPath(sourceURL.pathname.slice(1).replace(/\.git$/, ""), remote.provider) ||
		typeof branch !== "string" ||
		!branch ||
		!SHA.test(pr.headSha)
	)
		throw new Error("The PR source branch or repository is unavailable.")
	return { ...target, pullRequest: pr, branch, cloneURL: sourceURL.href }
}

/** Discovery is requested explicitly; the saved general preference never scans an account. */
export async function discoverMyOpenPRs(
	signal: AbortSignal,
	provider: Repository["provider"] = "github",
	host?: string,
): Promise<string[]> {
	const address =
		host ??
		(provider === "github"
			? (process.env.GH_HOST ?? "github.com")
			: (process.env.GITLAB_HOST ?? process.env.GL_HOST ?? process.env.GITLAB_URI ?? "gitlab.com"))
	const configured = new URL(address.includes("://") ? address : `https://${address}`)
	if (
		configured.protocol !== "https:" ||
		configured.username ||
		configured.password ||
		configured.pathname !== "/" ||
		configured.search ||
		configured.hash
	)
		throw new Error("Use a Git provider hostname without credentials or a path.")
	const remote: Repository = { provider, host: configured.host, name: "_/_" }
	const deadline = Date.now() + 60_000
	remote.token = await credential(remote, signal, deadline, new Map())
	if (!remote.token)
		throw new Error(
			`Sign in to ${provider === "github" ? "GitHub" : "GitLab"} for ${remote.host} before finding your PRs or MRs.`,
		)
	const base = api(remote).origin
	if (provider === "gitlab") {
		const { value: user } = await requestJSON(remote, new URL("/api/v4/user", base), signal, deadline)
		if (!object(user) || typeof user.id !== "number" || !Number.isSafeInteger(user.id) || user.id <= 0)
			throw new Error("GitLab did not return the signed-in user.")
		const endpoint = new URL("/api/v4/merge_requests", base)
		endpoint.search = new URLSearchParams({ scope: "created_by_me", state: "opened", per_page: "100" }).toString()
		const records = await pages(remote, endpoint, signal, deadline)
		return [
			...new Set(
				records.map((record) => {
					if (
						!object(record) ||
						!object(record.author) ||
						record.author.id !== user.id ||
						record.state !== "opened" ||
						typeof record.web_url !== "string"
					)
						throw new Error("GitLab returned an MR outside the requested author or state.")
					const parsed = parsePRTarget(record.web_url)
					if (parsed.repository.host !== remote.host || parsed.repository.provider !== "gitlab")
						throw new Error("GitLab returned an MR on a different host.")
					return parsed.url
				}),
			),
		]
	}
	const prefix = api(remote).pathname.startsWith("/api/v3/") ? "/api/v3" : ""
	const { value: user } = await requestJSON(remote, new URL(`${prefix}/user`, base), signal, deadline)
	if (!object(user) || typeof user.login !== "string" || !/^[\w-]+$/.test(user.login))
		throw new Error("GitHub did not return the signed-in user.")
	const urls = new Set<string>()
	for (let page = 1; ; page++) {
		const url = new URL(`${prefix}/search/issues`, base)
		url.search = new URLSearchParams({
			q: `is:pr is:open author:${user.login}`,
			per_page: "100",
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
		if (value.total_count > 1000)
			throw new Error(
				"GitHub search returns at most 1000 results. Narrow the request or supply PR URLs; the watcher has no PR-count limit.",
			)
		for (const item of value.items) {
			if (!object(item) || !object(item.pull_request) || typeof item.html_url !== "string")
				throw new Error("GitHub returned an invalid PR search result.")
			const parsed = parsePRTarget(item.html_url)
			if (parsed.repository.host !== remote.host) throw new Error("GitHub returned a PR on a different host.")
			urls.add(parsed.url)
		}
		if (page * 100 >= value.total_count) return [...urls]
		if (!value.items.length) throw new Error("GitHub returned an incomplete PR search. Supply PR URLs instead.")
	}
}

export async function preparePRCheckout(
	ctx: ExtensionToolContext,
	url: string,
	signal: AbortSignal,
	directory?: string,
	requireTrust = true,
): Promise<string> {
	const target = await readPRTarget(url, signal)
	if (target.pullRequest.state !== "open") throw new Error("This PR is no longer open.")
	const key = createHash("sha256").update(`${ctx.sessionManager.getSessionId()}:${target.url}`).digest("hex")
	const cwd = directory ? resolve(ctx.cwd, directory) : join(getAgentDir(), "pr-watch", "checkouts", key)
	if (!existsSync(join(cwd, ".git"))) {
		if (directory || existsSync(cwd))
			throw new Error(`No Git checkout at ${cwd}. Choose a checkout or let Kimchi create an isolated one.`)
		await mkdir(dirname(cwd), { recursive: true, mode: 0o700 })
		const cli = target.repository.provider === "github" ? "gh" : "glab"
		const outcome = await ctx.executeTool(
			"bash",
			{
				command: quote([
					cli,
					"repo",
					"clone",
					target.cloneURL,
					cwd,
					"--",
					"--single-branch",
					"--branch",
					target.branch,
				]),
				timeout: 120,
			},
			{ signal },
		)
		if (outcome.isError)
			throw new Error(
				`Could not prepare ${target.url}. ${outcome.result.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join(" ")
					.slice(0, 600)}`,
			)
	}
	signal.throwIfAborted()
	if (requireTrust && !resolvePreMainProjectTrust(cwd, getAgentDir())) {
		if (
			!ctx.hasUI ||
			!(await ctx.ui.confirm(
				"Trust PR checkout?",
				`Allow automatic repairs in ${cwd}? Normal tool permissions still apply.`,
				{ signal },
			))
		)
			throw new Error(`Trust ${cwd} before enabling auto-fix.`)
		new ProjectTrustStore(getAgentDir()).set(cwd, true)
	}
	return cwd
}
