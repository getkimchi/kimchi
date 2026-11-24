/**
 * Branch-status lookup (the checked-out branch's PR, independent of recorded
 * work) is Kimchi session/UI code: these cases stayed when the work PR
 * reconcile modules moved to @getkimchi/kimchi-bridge, so their coverage stays
 * co-located here. The moved work-lookup suites live in the bridge
 * (test/reconcile/pull-request-status).
 */
import type { ExecFileOptions } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { lookupFailureReason } from "@getkimchi/kimchi-bridge/reconcile"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installKimchiHostPorts } from "../work-attribution/host-ports.js"
import { lookupBranchPullRequest } from "./branch-status.js"

// The bridge provider modules resolve credentials and the token through
// HostPorts; bind Kimchi's in-process host wherever the lookup runs outside a
// supervisor pass (same convention as the other bridge consumers).
installKimchiHostPorts()

const cli = vi.hoisted(() => ({
	git: vi.fn<(args: string[], options: ExecFileOptions) => Promise<string | undefined>>(),
	auth: vi.fn<(command: string, args: string[], options: ExecFileOptions) => Promise<string | undefined>>(),
	token: vi.fn<(host: string) => string | undefined>(),
}))
vi.mock("../../config.js", async (original) => ({
	...(await original<typeof import("../../config.js")>()),
	readGitToken: cli.token,
}))
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	execFile: vi.fn((command, args, options, callback) => {
		const result = command === "git" ? cli.git(args, options) : cli.auth(command, args, options)
		void result.then(
			(value) => callback(null, value ?? "", ""),
			(error) => callback(error, "", error.stderr ?? ""),
		)
	}),
}))

type Provider = "github" | "gitlab"
const providers = ["github", "gitlab"] as const
const http = vi.fn<(url: URL, options: RequestInit) => Promise<Response>>()
const sha = "a".repeat(40)
let directory: string
let repository: string
let agentDir: string
const authEnv = [
	"GH_HOST",
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
]

function remote(value = "https://github.com/team/repo.git", branch = "feature", extra = ""): void {
	cli.git.mockImplementation(async (args) => {
		if (args.includes("--get-regexp")) return `remote.origin.url ${value}\n${extra}`
		if (args.includes("symbolic-ref")) return branch || undefined
		throw new Error("Unexpected Git command")
	})
}
/** Answers `git reflog` for the `feature` branch with entries at these Unix times, newest first. */
function reflog(...times: number[]): void {
	const git = cli.git.getMockImplementation()
	cli.git.mockImplementation(async (args, options) =>
		args.includes("reflog") ? times.map((time) => `feature@{${time}}`).join("\n") : git?.(args, options),
	)
}
function pull(number = 7, overrides: Record<string, unknown> = {}) {
	return {
		id: 98000 + number,
		base: { repo: { id: 42 } },
		html_url: `https://github.com/team/repo/pull/${number}`,
		number,
		state: "open",
		head: { sha, ref: "feature" },
		merge_commit_sha: null,
		merged_at: null,
		closed_at: null,
		...overrides,
	}
}
function mr(number = 7, overrides: Record<string, unknown> = {}) {
	return {
		id: 98724 + number,
		iid: number,
		web_url: `https://gitlab.com/team/subgroup/repo/-/merge_requests/${number}`,
		state: "opened",
		sha,
		source_branch: "feature",
		source_project_id: 42,
		target_project_id: 42,
		merge_commit_sha: null,
		...overrides,
	}
}
function replies(handler: (url: URL, options: RequestInit) => unknown = () => []): void {
	http.mockImplementation(async (url, options) => {
		const github = /^\/(?:api\/v3\/)?repos\/([^/]+\/[^/]+)$/.exec(url.pathname)
		const gitlab = /^\/api\/v4\/projects\/([^/]+)$/.exec(url.pathname)
		const value = github
			? {
					id: 42,
					default_branch: "main",
					full_name: github[1],
					// GitHub.com and GHE.com serve their API from an api. subdomain of the web host.
					html_url: `https://${url.host.startsWith("api.") ? url.host.slice("api.".length) : url.host}/${github[1]}`,
				}
			: gitlab
				? {
						id: 42,
						default_branch: "main",
						path_with_namespace: decodeURIComponent(gitlab[1]),
						web_url: `${url.origin}/${decodeURIComponent(gitlab[1])}`,
					}
				: await handler(url, options)
		return value instanceof Response ? value : Response.json(value)
	})
}
function useProvider(provider: Provider): void {
	remote(provider === "github" ? "git@github.com:team/repo.git" : "git@gitlab.com:team/subgroup/repo.git")
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "kimchi-branch-status-"))
	repository = join(directory, "repo.git")
	agentDir = join(directory, "agent")
	mkdirSync(repository)
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir)
	for (const name of authEnv) vi.stubEnv(name, undefined)
	// Without `glab config path`, lookups read glab's files below the home folder; keep real logins out.
	vi.stubEnv("HOME", directory)
	for (const name of ["USERPROFILE", "XDG_CONFIG_HOME", "LOCALAPPDATA", "GLAB_CONFIG_DIR", "NO_PROMPT"])
		vi.stubEnv(name, undefined)
	cli.git.mockReset()
	cli.auth.mockReset().mockResolvedValue(undefined)
	cli.token.mockReset().mockReturnValue(undefined)
	http.mockReset()
	remote()
	replies()
	vi.stubGlobal("fetch", http)
})
afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
	rmSync(directory, { recursive: true, force: true })
})

describe("repository and branch selection", () => {
	it("skips the branch PR lookup on GitLab's default branch", async () => {
		remote("git@gitlab.com:team/subgroup/repo.git", "master")
		http.mockImplementation(async (url) => {
			if (url.pathname === "/api/v4/projects/team%2Fsubgroup%2Frepo")
				return Response.json({
					id: 42,
					path_with_namespace: "team/subgroup/repo",
					web_url: "https://gitlab.com/team/subgroup/repo",
					default_branch: "master",
				})
			return Response.json([
				mr(7, {
					source_branch: "master",
					state: "closed",
					author: { username: "jose" },
					updated_at: "2026-10-16T10:00:00Z",
					closed_at: "2026-10-16T09:00:00Z",
				}),
			])
		})
		const result = await lookupBranchPullRequest(repository, new AbortController().signal)
		// Another author's closed MR on the shared default branch is not this user's orientation.
		expect(result).toEqual({ branch: "master", pullRequest: undefined })
		expect(http.mock.calls.map(([url]) => url.pathname)).toEqual(["/api/v4/projects/team%2Fsubgroup%2Frepo"])
		expect(existsSync(agentDir)).toBe(false)
	})
	it("skips the branch PR lookup on GitHub's default branch", async () => {
		remote("https://github.com/team/repo.git", "main")
		http.mockImplementation(async (url) => {
			if (url.pathname === "/repos/team/repo")
				return Response.json({
					id: 1,
					full_name: "team/repo",
					html_url: "https://github.com/team/repo",
					default_branch: "main",
				})
			return Response.json([pull(7, { state: "closed", head: { sha, ref: "main" } })])
		})
		const result = await lookupBranchPullRequest(repository, new AbortController().signal)
		expect(result).toEqual({ branch: "main", pullRequest: undefined })
		expect(http.mock.calls.map(([url]) => url.pathname)).toEqual(["/repos/team/repo"])
		expect(existsSync(agentDir)).toBe(false)
	})
	it("skips the branch PR lookup on a custom default branch", async () => {
		remote("git@gitlab.com:team/subgroup/repo.git", "develop")
		http.mockImplementation(async (url) => {
			if (url.pathname === "/api/v4/projects/team%2Fsubgroup%2Frepo")
				return Response.json({
					id: 42,
					path_with_namespace: "team/subgroup/repo",
					web_url: "https://gitlab.com/team/subgroup/repo",
					default_branch: "develop",
				})
			return Response.json([mr(7, { source_branch: "develop" })])
		})
		const result = await lookupBranchPullRequest(repository, new AbortController().signal)
		expect(result).toEqual({ branch: "develop", pullRequest: undefined })
		expect(http.mock.calls.map(([url]) => url.pathname)).toEqual(["/api/v4/projects/team%2Fsubgroup%2Frepo"])
	})
	it("discards a suppressed default-branch result when checkout changes during the metadata request", async () => {
		remote("https://github.com/team/repo.git", "main")
		http.mockImplementation(async () => {
			// The checkout changes while the repository metadata resolves; no PR list request may follow.
			remote(undefined, "other")
			return Response.json({
				id: 1,
				full_name: "team/repo",
				html_url: "https://github.com/team/repo",
				default_branch: "main",
			})
		})
		expect(await lookupBranchPullRequest(repository, new AbortController().signal)).toBeUndefined()
		expect(http).toHaveBeenCalledOnce()
	})
	it.each([
		["absent", undefined],
		["empty", ""],
		["null", null],
		["non-string", 42],
	] as const)("hides the branch PR when default_branch metadata is %s", async (_case, value) => {
		useProvider("github")
		http.mockImplementation(async (url) => {
			if (url.pathname === "/repos/team/repo")
				return Response.json({
					id: 1,
					full_name: "team/repo",
					html_url: "https://github.com/team/repo",
					...(value === undefined ? {} : { default_branch: value }),
				})
			return Response.json([pull()])
		})
		const result = await lookupBranchPullRequest(repository, new AbortController().signal)
		expect(result).toEqual({ branch: "feature", pullRequest: undefined })
		expect(http).toHaveBeenCalledOnce()
	})
	it.each(providers)("shows the current %s branch without creating attribution records", async (provider) => {
		useProvider(provider)
		replies(() => (provider === "github" ? [pull()] : [mr()]))
		const result = await lookupBranchPullRequest(repository, new AbortController().signal)
		expect(result).toMatchObject({ branch: "feature", pullRequest: { provider, number: 7, state: "open" } })
		expect(existsSync(agentDir)).toBe(false)
	})
	describe.each(providers)("closed and merged %s branch PRs", (provider) => {
		const other = "b".repeat(40)
		// The local branch was created at this time; its PRs closed a day before or after.
		const created = Date.parse("2026-10-01T12:00:00Z") / 1000
		const before = "2026-09-30T12:00:00Z"
		const after = "2026-10-02T12:00:00Z"
		const closed = (number: number, at: string, head = sha) =>
			provider === "github"
				? pull(number, { state: "closed", closed_at: at, head: { sha: head, ref: "feature" } })
				: mr(number, { state: "closed", closed_at: at, sha: head })
		const merged = (number: number, at: string, head = sha) =>
			provider === "github"
				? pull(number, {
						state: "closed",
						merged_at: at,
						closed_at: at,
						merge_commit_sha: "f".repeat(40),
						head: { sha: head, ref: "feature" },
					})
				: mr(number, { state: "merged", merged_at: at, merge_commit_sha: "f".repeat(40), sha: head })
		const malformed = (number: number) =>
			provider === "github"
				? pull(number, { state: "closed", head: { sha: "not-a-sha", ref: "feature" } })
				: mr(number, { state: "closed", sha: null })
		const open = () => (provider === "github" ? pull() : mr())
		const reflogCalls = () => cli.git.mock.calls.filter(([args]) => args.includes("reflog")).map(([args]) => args)

		beforeEach(() => useProvider(provider))

		it("prefers the open PR over a newer closed one without reading the reflog", async () => {
			replies((url) => {
				if (provider === "github") expect(url.searchParams.get("per_page")).toBe("30")
				return [closed(8, after, other), open()]
			})
			expect(await lookupBranchPullRequest(repository, new AbortController().signal)).toMatchObject({
				pullRequest: { number: 7, state: "open" },
			})
			expect(reflogCalls()).toEqual([])
		})
		it("hides a PR that closed before this branch was created, even when the branch starts at its head", async () => {
			// A fast-forward merge leaves the old PR's head on the default branch, where the reused name starts.
			reflog(created + 3600, created)
			replies(() => [merged(8, before)])
			expect(await lookupBranchPullRequest(repository, new AbortController().signal)).toEqual({
				branch: "feature",
				pullRequest: undefined,
			})
			expect(reflogCalls()).toEqual([
				["-C", repository, "reflog", "show", "--date=unix", "--format=%gd", "refs/heads/feature", "--"],
			])
		})
		it("shows the newest PR that closed after this branch was created, whatever its head", async () => {
			// The provider can move the head after the last push: a rebase button, a suggestion or a bot commit.
			reflog(created + 3600, created)
			replies(() => [closed(9, before), merged(7, after, other), closed(6, after)])
			expect(await lookupBranchPullRequest(repository, new AbortController().signal)).toMatchObject({
				pullRequest: { number: 7, state: "merged", headSha: other },
			})
		})
		it("dates the branch from its oldest reflog entry, not its latest update", async () => {
			reflog(created + 3600, created)
			replies(() => [merged(7, new Date((created + 1800) * 1000).toISOString())])
			expect(await lookupBranchPullRequest(repository, new AbortController().signal)).toMatchObject({
				pullRequest: { number: 7, state: "merged" },
			})
		})
		it("hides a merged PR when Git keeps no reflog for the branch", async () => {
			reflog()
			replies(() => [merged(7, after)])
			expect(await lookupBranchPullRequest(repository, new AbortController().signal)).toEqual({
				branch: "feature",
				pullRequest: undefined,
			})
			expect(reflogCalls()).toHaveLength(1)
		})
		it("shows a valid open PR beside a malformed older record", async () => {
			replies(() => [malformed(8), open()])
			expect(await lookupBranchPullRequest(repository, new AbortController().signal)).toMatchObject({
				pullRequest: { number: 7, state: "open" },
			})
		})
		it("reports a malformed record when no other PR can be shown", async () => {
			replies(() => [malformed(8)])
			await expect(lookupBranchPullRequest(repository, new AbortController().signal)).rejects.toThrow(
				"invalid pull request",
			)
		})
	})
	it.each(providers)("never trims the checked-out %s branch into another branch's PR", async (provider) => {
		useProvider(provider)
		const branch = "feature\u00a0"
		remote(
			provider === "github" ? "https://github.com/team/repo.git" : "https://gitlab.com/team/subgroup/repo.git",
			`${branch}\n`,
		)
		replies((url) => {
			const source =
				provider === "github"
					? url.searchParams.get("head")?.slice("team:".length)
					: url.searchParams.get("source_branch")
			return source === "feature" ? (provider === "github" ? [pull()] : [mr()]) : []
		})
		expect(await lookupBranchPullRequest(repository, new AbortController().signal)).toEqual({
			branch,
			pullRequest: undefined,
		})
		const url = http.mock.calls.at(-1)?.[0]
		expect(url?.searchParams.get(provider === "github" ? "head" : "source_branch")).toBe(
			provider === "github" ? `team:${branch}` : branch,
		)
	})
	it("resolves the renamed repository before using an exact numeric branch filter", async () => {
		remote("https://github.com/old/repo.git", "1320")
		http.mockImplementation(async (url) => {
			if (url.pathname === "/repos/old/repo")
				return new Response(null, { status: 301, headers: { location: "/repos/renamed/repo" } })
			if (url.pathname === "/repos/renamed/repo")
				return Response.json({
					full_name: "renamed/repo",
					html_url: "https://github.com/renamed/repo",
					default_branch: "main",
				})
			expect(url.pathname).toBe("/repos/renamed/repo/pulls")
			expect(url.searchParams.get("head")).toBe("renamed:1320")
			return Response.json([
				pull(7, { html_url: "https://github.com/renamed/repo/pull/7", head: { sha, ref: "1320" } }),
			])
		})
		expect(await lookupBranchPullRequest(repository, new AbortController().signal)).toMatchObject({
			branch: "1320",
			pullRequest: { number: 7, repository: "renamed/repo" },
		})
		expect(existsSync(agentDir)).toBe(false)
	})
	it("uses the branch's upstream remote before origin when several remotes exist", async () => {
		remote(
			"https://github.com/wrong/repo.git",
			"feature",
			"remote.upstream.url https://github.com/team/repo.git\nbranch.feature.remote upstream\n",
		)
		replies(() => [pull()])
		await lookupBranchPullRequest(repository, new AbortController().signal)
		expect(http.mock.calls[0][0].pathname).toBe("/repos/team/repo")
	})
	it("stays quiet outside a repository or on a detached HEAD", async () => {
		cli.git.mockResolvedValue(undefined)
		expect(await lookupBranchPullRequest(repository, new AbortController().signal)).toBeUndefined()
		expect(http).not.toHaveBeenCalled()
		expect(cli.auth).not.toHaveBeenCalled()
	})
	it.each(["feature", "1320"])("treats branch %s without a PR as an ordinary empty result", async (branch) => {
		remote(undefined, branch)
		expect(await lookupBranchPullRequest(repository, new AbortController().signal)).toEqual({
			branch,
			pullRequest: undefined,
		})
	})
	it("rejects a GitHub result for another branch", async () => {
		replies(() => [pull(7, { head: { sha, ref: "wrong" } })])
		await expect(lookupBranchPullRequest(repository, new AbortController().signal)).rejects.toThrow("different branch")
	})
	it("finds this GitLab project's MR after a fork's same-name branch on an earlier page", async () => {
		useProvider("gitlab")
		replies((url) => {
			expect(url.searchParams.get("source_branch")).toBe("feature")
			// Current GitLab filters forks out itself; an older server ignores the filter and pages through them.
			expect(url.searchParams.get("source_project_id")).toBe("42")
			if (!url.searchParams.has("page"))
				return Response.json([mr(8, { source_project_id: 99 })], { headers: { "x-next-page": "2" } })
			return [mr()]
		})
		expect(await lookupBranchPullRequest(repository, new AbortController().signal)).toMatchObject({
			pullRequest: { provider: "gitlab", number: 7 },
		})
		expect(http).toHaveBeenCalledTimes(3)
	})
	it("follows gitlab.com's next page when its Link header adds the route and defaulted filters", async () => {
		useProvider("gitlab")
		replies((url) => {
			if (url.searchParams.get("page") === "2") return [mr()]
			// As gitlab.com answers a merge request list: the Link header repeats the project route and adds
			// with_labels_details and with_merge_status_recheck, which the request never sent.
			const page = (number: number) => {
				const link = new URL(url)
				link.searchParams.set("id", "team/subgroup/repo")
				link.searchParams.set("page", String(number))
				link.searchParams.set("with_labels_details", "false")
				link.searchParams.set("with_merge_status_recheck", "false")
				return link.href
			}
			return Response.json([mr(8, { source_project_id: 99 })], {
				headers: {
					link: `<${page(2)}>; rel="next", <${page(1)}>; rel="first", <${page(2)}>; rel="last"`,
					"x-next-page": "2",
				},
			})
		})
		expect(await lookupBranchPullRequest(repository, new AbortController().signal)).toMatchObject({
			pullRequest: { provider: "gitlab", number: 7 },
		})
		const pages = http.mock.calls.map(([url]) => url).filter((url) => url.pathname.endsWith("/merge_requests"))
		expect(pages.map((url) => url.searchParams.has("with_labels_details"))).toEqual([false, false])
	})
	it("does not display another GitLab project's same-name branch when no local-source MR exists", async () => {
		useProvider("gitlab")
		replies(() => [mr(8, { source_project_id: 99 })])
		expect(await lookupBranchPullRequest(repository, new AbortController().signal)).toEqual({
			branch: "feature",
			pullRequest: undefined,
		})
	})
	it("discards a result when checkout changes during the request", async () => {
		replies(() => {
			remote(undefined, "other")
			return [pull()]
		})
		expect(await lookupBranchPullRequest(repository, new AbortController().signal)).toBeUndefined()
	})
})

describe("branch lookup failure reasons", () => {
	it.each([
		["requires sign-in", () => new Response(null, { status: 401 })],
		["is forbidden", () => new Response("<html>Access denied</html>", { status: 403 })],
		["redirects to SSO", () => new Response(null, { status: 302, headers: { location: "https://sso.corp.example/" } })],
		[
			"is unreachable",
			() => {
				throw new TypeError("fetch failed")
			},
		],
	] as const)("treats an unconfigured host whose API %s as unsupported", async (name, reply) => {
		remote(`https://${name.replaceAll(" ", "-")}.corp.example/team/repo.git`)
		http.mockImplementation(async () => reply())
		const failure = await lookupBranchPullRequest(repository, new AbortController().signal).catch((error) => error)
		expect(lookupFailureReason(failure)).toBe("unsupported")
	})
	it("keeps a self-hosted GitLab's own 404 actionable without GITLAB_HOST", async () => {
		remote("https://gitlab.corp.example/team/repo.git")
		vi.stubEnv("GITLAB_TOKEN", "gitlab-com-token")
		http.mockImplementation(async () => Response.json({ message: "404 Project Not Found" }, { status: 404 }))
		const failure = await lookupBranchPullRequest(repository, new AbortController().signal).catch((error) => error)
		expect({ message: failure.message, reason: lookupFailureReason(failure) }).toEqual({
			message: expect.stringContaining("GitLab could not find this repository"),
			reason: undefined,
		})
	})
	it("keeps an expired saved GitLab token actionable on an unconfigured host", async () => {
		remote("https://gitlab.tokens.example/team/repo.git")
		cli.token.mockImplementation((host) => (host === "gitlab.tokens.example" ? "expired-token" : undefined))
		http.mockImplementation(async (url) =>
			url.pathname.startsWith("/api/v4/")
				? Response.json(
						{
							error: "invalid_token",
							error_description: "Token is expired. You can either do re-authorization or token refresh.",
						},
						{ status: 401 },
					)
				: Response.json({ error: "404 Not Found" }, { status: 404 }),
		)
		const failure = await lookupBranchPullRequest(repository, new AbortController().signal).catch((error) => error)
		expect({ message: failure.message, reason: lookupFailureReason(failure) }).toEqual({
			message: expect.stringContaining("GitLab authentication failed"),
			reason: undefined,
		})
	})
	it("marks a repository without GitHub or GitLab as unsupported in branch lookups", async () => {
		remote("https://bitbucket.org/team/repo.git")
		http.mockImplementation(async () => new Response(null, { status: 404 }))
		const failure = await lookupBranchPullRequest(repository, new AbortController().signal).catch((error) => error)
		expect(lookupFailureReason(failure)).toBe("unsupported")
	})
	it("keeps a Bitbucket repository unsupported when gh returns a token for its host", async () => {
		remote("https://bitbucket.org/team/repo.git")
		// gh returns GH_ENTERPRISE_TOKEN for any host that is not github.com.
		cli.auth.mockImplementation(async (command, args) =>
			command === "gh" && args.join(" ") === "auth token --hostname bitbucket.org" ? "enterprise-token" : undefined,
		)
		http.mockImplementation(async () => new Response("<html>Not Found</html>", { status: 404 }))
		const failure = await lookupBranchPullRequest(repository, new AbortController().signal).catch((error) => error)
		expect(lookupFailureReason(failure)).toBe("unsupported")
		expect(http.mock.calls.every(([url]) => !url.pathname.startsWith("/api/v4/"))).toBe(true)
	})
	it("keeps a GitHub Enterprise 404 actionable when gh returns a token for an unconfigured host", async () => {
		remote("https://github.corp.example/team/repo.git")
		cli.auth.mockImplementation(async (command) => (command === "gh" ? "enterprise-token" : undefined))
		http.mockImplementation(async () =>
			Response.json({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }, { status: 404 }),
		)
		const failure = await lookupBranchPullRequest(repository, new AbortController().signal).catch((error) => error)
		expect({ message: failure.message, reason: lookupFailureReason(failure) }).toEqual({
			message: expect.stringContaining("GitHub could not find this repository"),
			reason: undefined,
		})
	})
})
