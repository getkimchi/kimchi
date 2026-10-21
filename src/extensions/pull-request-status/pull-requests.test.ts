import type { ExecFileOptions } from "node:child_process"
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parse as parseYaml } from "yaml"
import * as summaries from "../work-attribution/summary.js"
import { lookupBranchPullRequest } from "./branch-status.js"
import { lookupFailureReason } from "./provider-records.js"
import { readWorkPullRequestUpdates, reconcileWorkPullRequests, type WorkPullRequestUpdate } from "./pull-requests.js"

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
const workId = "11111111-1111-4111-8111-111111111111"
const otherWorkId = "22222222-2222-4222-8222-222222222222"
const sha = "a".repeat(40)
let directory: string
let repository: string
let agentDir: string
let updates: WorkPullRequestUpdate[]
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
function seed(overrides: Record<string, unknown> = {}, transitions = false): void {
	const source = join(agentDir, "work-attribution", ...(transitions ? ["transitions"] : []))
	mkdirSync(source, { recursive: true })
	appendFileSync(
		join(source, "source.jsonl"),
		`${JSON.stringify({
			version: 1,
			type: "commit",
			workId,
			sessionId: "writer",
			cwd: join(directory, "removed-worktree"),
			worktree: join(directory, "removed-worktree"),
			repository,
			sha,
			...overrides,
		})}\n`,
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
function stored(provider: Provider = "github", overrides: Record<string, unknown> = {}) {
	return {
		provider,
		url: provider === "github" ? pull().html_url : mr().web_url,
		number: 7,
		state: "open",
		repository: provider === "github" ? "team/repo" : "team/subgroup/repo",
		host: `${provider}.com`,
		headSha: sha,
		mergeCommitSha: null,
		mergedAt: null,
		closedAt: null,
		checkedAt: "2026-10-01T12:00:00Z",
		...overrides,
	}
}
function lookup(signal = new AbortController().signal, assertLease = () => {}): Promise<void> {
	return reconcileWorkPullRequests(agentDir, signal, assertLease, (update) => updates.push(update))
}
function saved(sessionId = "writer") {
	return readFileSync(join(agentDir, "work-attribution", `${sessionId}.jsonl`), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
}
/** By default, moves the clock past the shortest delay before a commit is checked again. */
function later(ms = 31_000): void {
	const now = Date.now() + ms
	vi.useFakeTimers({ toFake: ["Date"] })
	vi.setSystemTime(now)
}
function commitCalls(): URL[] {
	return http.mock.calls.map(([url]) => url).filter((url) => url.pathname.includes("/commits/"))
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
					html_url: `https://${url.host === "api.github.com" ? "github.com" : url.host}/${github[1]}`,
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
function gitlabConfig(contents: string): string {
	const path = join(directory, "glab-config.yml")
	writeFileSync(path, contents)
	return path
}
/** Saves a glab config.yml whose gitlab.com login is `token`, in a folder below the test's home. */
function glabHome(folder: string, token: string): void {
	const path = join(directory, folder, "config.yml")
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, `hosts:\n  gitlab.com:\n    token: ${token}\n`)
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "kimchi-pull-requests-"))
	repository = join(directory, "repo.git")
	agentDir = join(directory, "agent")
	mkdirSync(repository)
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir)
	for (const name of authEnv) vi.stubEnv(name, undefined)
	// Without `glab config path`, lookups read glab's files below the home folder; keep real logins out.
	vi.stubEnv("HOME", directory)
	for (const name of ["USERPROFILE", "XDG_CONFIG_HOME", "LOCALAPPDATA", "GLAB_CONFIG_DIR", "NO_PROMPT"])
		vi.stubEnv(name, undefined)
	updates = []
	cli.git.mockReset()
	cli.auth.mockReset().mockResolvedValue(undefined)
	cli.token.mockReset().mockReturnValue(undefined)
	http.mockReset()
	remote()
	replies()
	vi.stubGlobal("fetch", http)
})
afterEach(async () => {
	vi.useRealTimers()
	await summaries.flushWorkSummaries()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
	rmSync(directory, { recursive: true, force: true })
})

describe("native provider credentials", () => {
	it.each(providers)("keeps the target %s repository and global PR IDs for fork contributions", async (provider) => {
		seed()
		useProvider(provider)
		replies(() =>
			provider === "github"
				? [pull(7, { id: 98731, base: { repo: { id: 42 } }, head: { sha, repo: { id: 999 } } })]
				: [mr(7, { target_project_id: 42, source_project_id: 999 })],
		)
		await lookup()
		expect(saved().at(-1).pullRequests[0]).toMatchObject({ id: "98731", repositoryId: "42" })
		expect(readWorkPullRequestUpdates(agentDir)[0].pullRequests[0]).toMatchObject({ id: "98731", repositoryId: "42" })
	})
	it("refreshes merged legacy links to obtain stable IDs", async () => {
		seed({
			prLookup: { status: "linked", checkedAt: "2026-10-01T12:00:00Z" },
			pullRequests: [stored("github", { state: "merged", mergedAt: "2026-10-01T11:00:00Z" })],
		})
		replies(() => [
			pull(7, { id: 98731, base: { repo: { id: 42 } }, state: "closed", merged_at: "2026-10-01T11:00:00Z" }),
		])
		await lookup()
		expect(saved().at(-1).pullRequests[0]).toMatchObject({ id: "98731", repositoryId: "42" })
	})
	it.each(providers)("matches %s with a saved token and no CLI", async (provider) => {
		seed()
		useProvider(provider)
		cli.token.mockImplementation((host) => (host === `${provider}.com` ? "saved-test-token" : undefined))
		cli.auth.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }))
		replies(() => (provider === "github" ? [pull()] : [mr()]))
		await lookup()
		expect(saved().at(-1)).toMatchObject({
			prLookup: { status: "linked" },
			pullRequests: [
				{ provider, number: 7, state: "open", repository: provider === "github" ? "team/repo" : "team/subgroup/repo" },
			],
		})
		expect(commitCalls()[0].pathname).toBe(
			provider === "github"
				? `/repos/team/repo/commits/${sha}/pulls`
				: `/api/v4/projects/team%2Fsubgroup%2Frepo/repository/commits/${sha}/merge_requests`,
		)
		for (const [, options] of http.mock.calls)
			expect(new Headers(options.headers).get("authorization")).toBe("Bearer saved-test-token")
		expect(cli.auth).not.toHaveBeenCalled()
	})
	it.each(providers)("reads a public %s repository without credentials or CLI", async (provider) => {
		seed()
		useProvider(provider)
		cli.auth.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }))
		await lookup()
		expect(saved().at(-1).prLookup.status).toBe("pending")
		expect(http).toHaveBeenCalledTimes(2)
		for (const [, options] of http.mock.calls) expect(new Headers(options.headers).has("authorization")).toBe(false)
	})
	it.each(providers)("prefers the host-bound %s environment token over saved and CLI tokens", async (provider) => {
		seed()
		useProvider(provider)
		vi.stubEnv(provider === "github" ? "GH_TOKEN" : "GITLAB_TOKEN", "environment-test-token")
		cli.token.mockReturnValue("saved-alternative")
		cli.auth.mockResolvedValue("cli-alternative")
		await lookup()
		expect(cli.token).not.toHaveBeenCalled()
		expect(cli.auth).not.toHaveBeenCalled()
		for (const [, options] of http.mock.calls)
			expect(new Headers(options.headers).get("authorization")).toBe("Bearer environment-test-token")
	})
	it.each(providers)("uses only the selected host's %s CLI token without CLI side effects", async (provider) => {
		seed()
		useProvider(provider)
		vi.stubEnv("OAUTH_TOKEN", "unrelated-secret")
		vi.stubEnv("GITLAB_URI", "https://wrong.example")
		vi.stubEnv("GIT_DIR", "/wrong/repository")
		vi.stubEnv("GH_REPO", "wrong/repository")
		vi.stubEnv("GLAB_ENABLE_CI_AUTOLOGIN", "true")
		vi.stubEnv("GITLAB_CI", "true")
		// glab 1.80-1.100 print this variable's deprecation warning on stdout, ahead of the token.
		vi.stubEnv("NO_PROMPT", "true")
		cli.auth.mockResolvedValue(
			provider === "github" ? "cli-test-token" : gitlabConfig("hosts:\n  gitlab.com:\n    token: cli-test-token\n"),
		)
		await lookup()
		expect(cli.auth).toHaveBeenCalledOnce()
		const [command, args, options] = cli.auth.mock.calls[0]
		expect([command, args]).toEqual(
			provider === "github" ? ["gh", ["auth", "token", "--hostname", "github.com"]] : ["glab", ["config", "path"]],
		)
		for (const name of [...authEnv, "GIT_DIR", "GH_REPO", "NO_PROMPT"]) expect(options.env?.[name]).toBeUndefined()
		expect(options.env).toMatchObject({
			GH_PROMPT_DISABLED: "1",
			GH_NO_UPDATE_NOTIFIER: "1",
			GH_TELEMETRY: "false",
			GLAB_NO_PROMPT: "true",
			GLAB_SEND_TELEMETRY: "false",
			GLAB_CHECK_UPDATE: "false",
			GLAB_SHOW_WHATS_NEW: "false",
			GLAB_ENABLE_CI_AUTOLOGIN: "false",
		})
		expect(options.timeout).toBeLessThanOrEqual(5000)
		expect(options.maxBuffer).toBe(64 * 1024)
		expect(options.signal).toBeInstanceOf(AbortSignal)
		for (const [, options] of http.mock.calls)
			expect(new Headers(options.headers).get("authorization")).toBe("Bearer cli-test-token")
	})
	it.each(providers)("does not switch identities after %s rejects a direct token", async (provider) => {
		seed()
		useProvider(provider)
		vi.stubEnv(provider === "github" ? "GH_TOKEN" : "GITLAB_TOKEN", "rejected-secret")
		cli.token.mockReturnValue("saved-alternative")
		cli.auth.mockResolvedValue("cli-alternative")
		http.mockImplementation(async () => new Response("secret server text", { status: 401 }))
		await lookup()
		expect(http).toHaveBeenCalledOnce()
		expect(saved().at(-1).prLookup).toMatchObject({
			status: "error",
			error: expect.stringContaining("authentication failed"),
		})
		expect(JSON.stringify(saved())).not.toContain("secret")
		expect(cli.token).not.toHaveBeenCalled()
		expect(cli.auth).not.toHaveBeenCalled()
	})
	it.each(providers)("keeps an anonymous denied %s lookup separate from source records", async (provider) => {
		seed()
		useProvider(provider)
		http.mockImplementation(async () => new Response("private", { status: 404 }))
		await lookup()
		expect(saved().at(-1).prLookup).toMatchObject({
			status: "error",
			error: expect.stringContaining("may require authentication"),
		})
		expect(readWorkPullRequestUpdates(agentDir)).toHaveLength(1)
		expect(readWorkPullRequestUpdates(agentDir)[0].workId).toBe(workId)
	})
	it("never sends a cloud GitHub token to the explicitly configured Enterprise host", async () => {
		seed()
		remote("https://enterprise.example/team/repo.git")
		vi.stubEnv("GH_HOST", "enterprise.example")
		vi.stubEnv("GH_TOKEN", "cloud-secret")
		vi.stubEnv("GH_ENTERPRISE_TOKEN", "enterprise-token")
		await lookup()
		for (const [url, options] of http.mock.calls) {
			expect(url.origin).toBe("https://enterprise.example")
			expect(new Headers(options.headers).get("authorization")).toBe("Bearer enterprise-token")
		}
	})
	it("keeps a cloud GitHub token on github.com even when GH_HOST names another host", async () => {
		seed()
		vi.stubEnv("GH_HOST", "enterprise.example")
		vi.stubEnv("GH_TOKEN", "cloud-token")
		vi.stubEnv("GH_ENTERPRISE_TOKEN", "enterprise-secret")
		await lookup()
		for (const [, options] of http.mock.calls)
			expect(new Headers(options.headers).get("authorization")).toBe("Bearer cloud-token")
	})
	it("does not reuse another GitLab host's environment token", async () => {
		seed()
		useProvider("gitlab")
		vi.stubEnv("GITLAB_HOST", "other.example")
		vi.stubEnv("GITLAB_TOKEN", "other-host-secret")
		await lookup()
		for (const [, options] of http.mock.calls) expect(new Headers(options.headers).has("authorization")).toBe(false)
	})
	it("never sends an unscoped GitLab global token to a different host", async () => {
		seed()
		remote("https://other.example.test/team/repo.git")
		vi.stubEnv("GITLAB_HOST", "other.example.test")
		// glab config get --host falls back to its unscoped global token when this host is absent.
		const path = gitlabConfig("host: gitlab.com\ntoken: global-gitlab-com-token\n")
		cli.auth.mockImplementation(async (_command, args) => (args[1] === "path" ? path : "global-gitlab-com-token"))
		await lookup()
		for (const [, options] of http.mock.calls) expect(new Headers(options.headers).has("authorization")).toBe(false)
		expect(cli.auth.mock.calls.map(([, args]) => args)).toEqual([["config", "path"]])
	})
	it.each([
		"hosts:\n  other.example.test:\n    token: other-host-token\n",
		"hosts:\n  gitlab.com:\n    token: 123\n",
		"hosts:\n  gitlab.com:\n    use_keyring: false\n",
		"hosts:\n  gitlab.com:\n    use_keyring: 'false'\n",
		"hosts: [\n",
	])("does not use glab fallback credentials without a valid scoped token: %s", async (contents) => {
		seed()
		useProvider("gitlab")
		cli.auth.mockResolvedValue(gitlabConfig(`token: global-token\n${contents}`))
		await lookup()
		for (const [, options] of http.mock.calls) expect(new Headers(options.headers).has("authorization")).toBe(false)
		expect(saved().at(-1).prLookup.status).toBe("pending")
	})
	it("uses the exact GitLab host token while ignoring global and other host tokens", async () => {
		seed()
		remote("https://other.example.test/team/repo.git")
		vi.stubEnv("GITLAB_HOST", "other.example.test")
		cli.auth.mockResolvedValue(
			gitlabConfig(
				"token: global-token\nhosts:\n  gitlab.com:\n    token: cloud-token\n  other.example.test:\n    token: matched-token\n",
			),
		)
		await lookup()
		for (const [url, options] of http.mock.calls) {
			expect(url.host).toBe("other.example.test")
			expect(new Headers(options.headers).get("authorization")).toBe("Bearer matched-token")
		}
	})
	it.each([true, false])("honors glab keyring selection and cleans up when a token is found: %s", async (found) => {
		seed()
		useProvider("gitlab")
		const original =
			"token: global-token\nhosts:\n  gitlab.com:\n    token: old-plaintext-token\n    use_keyring: true\n  other.example:\n    token: other-token\n"
		const path = gitlabConfig(original)
		let temporary: string | undefined
		let isolated = false
		cli.auth.mockImplementation(async (_command, args, options) => {
			if (args[1] === "path") return path
			expect(args).toEqual(["config", "get", "token", "--host", "gitlab.com"])
			const directory = options.env?.GLAB_CONFIG_DIR
			if (!directory) throw new Error("Missing isolated glab configuration")
			temporary = directory
			expect(options.cwd).toBe(directory)
			expect(options.env?.GIT_DIR).toBe(join(directory, ".git"))
			expect(existsSync(join(directory, ".git"))).toBe(false)
			for (const name of authEnv) expect(options.env?.[name]).toBeUndefined()
			expect(parseYaml(readFileSync(join(directory, "config.yml"), "utf8"))).toEqual({
				hosts: { "gitlab.com": { use_keyring: "true" } },
			})
			isolated = true
			return found ? "keyring-token" : undefined
		})
		await lookup()
		expect(cli.auth).toHaveBeenCalledTimes(2)
		expect(isolated).toBe(true)
		expect(temporary).toBeDefined()
		expect(temporary && existsSync(temporary)).toBe(false)
		expect(readFileSync(path, "utf8")).toBe(original)
		for (const [, options] of http.mock.calls)
			expect(new Headers(options.headers).get("authorization")).toBe(found ? "Bearer keyring-token" : null)
	})
	it("cleans up the isolated glab keyring config when lookup is cancelled", async () => {
		seed()
		useProvider("gitlab")
		const path = gitlabConfig("hosts:\n  gitlab.com:\n    use_keyring: 'true'\n")
		const controller = new AbortController()
		let temporary: string | undefined
		cli.auth.mockImplementation(async (_command, args, options) => {
			if (args[1] === "path") return path
			temporary = options.env?.GLAB_CONFIG_DIR
			controller.abort(new Error("cancelled keyring lookup"))
			return undefined
		})
		await expect(lookup(controller.signal)).rejects.toThrow("cancelled keyring lookup")
		expect(temporary).toBeDefined()
		expect(temporary && existsSync(temporary)).toBe(false)
		expect(http).not.toHaveBeenCalled()
		expect(existsSync(join(agentDir, "work-attribution", "writer.jsonl"))).toBe(false)
	})
	it.each([
		["prints its help, as glab 1.73 and 1.75-1.114 do", "Manage key/value strings.\n\n  Current respected settings:"],
		["is an unknown command, as glab 1.72 and older", undefined],
	])("finds an older glab's login when `glab config path` %s", async (_case, output) => {
		seed()
		useProvider("gitlab")
		glabHome(".config/glab-cli", "older-glab-token")
		cli.auth.mockImplementation(async (_command, args) => (args[1] === "path" ? output : "unexpected-command-token"))
		await lookup()
		expect(cli.auth.mock.calls.map(([, args]) => args)).toEqual([["config", "path"]])
		expect(http).toHaveBeenCalled()
		for (const [, options] of http.mock.calls)
			expect(new Headers(options.headers).get("authorization")).toBe("Bearer older-glab-token")
	})
	it.each([
		["GLAB_CONFIG_DIR", "custom-token"],
		["~/.config ahead of XDG_CONFIG_HOME, as glab 1.76+", "legacy-token"],
		["XDG_CONFIG_HOME", "xdg-token"],
		["Application Support on macOS", "app-support-token"],
	])("reads an older glab's login from %s", async (location, token) => {
		seed()
		useProvider("gitlab")
		if (location !== "XDG_CONFIG_HOME" && location !== "Application Support on macOS")
			glabHome(".config/glab-cli", "legacy-token")
		if (location === "GLAB_CONFIG_DIR") {
			vi.stubEnv("GLAB_CONFIG_DIR", join(directory, "custom"))
			glabHome("custom", "custom-token")
		} else if (location !== "Application Support on macOS") {
			vi.stubEnv("XDG_CONFIG_HOME", join(directory, "xdg"))
			glabHome("xdg/glab-cli", "xdg-token")
		}
		const platform = process.platform
		if (location === "Application Support on macOS") {
			Object.defineProperty(process, "platform", { value: "darwin" })
			glabHome("Library/Application Support/glab-cli", "app-support-token")
		}
		try {
			await lookup()
		} finally {
			Object.defineProperty(process, "platform", { value: platform })
		}
		expect(http).toHaveBeenCalled()
		for (const [, options] of http.mock.calls)
			expect(new Headers(options.headers).get("authorization")).toBe(`Bearer ${token}`)
	})
	it.each([
		"hosts:\n  gitlab.com: {}\n",
		"hosts:\n  gitlab.com:\n    git_protocol: ssh\n",
		"hosts:\n  gitlab.com:\n    token:\n",
		"hosts:\n  gitlab.com:\n    token: ''\n",
	])("asks the keyring for a login that glab before 1.84 saved without a token: %s", async (contents) => {
		seed()
		useProvider("gitlab")
		const path = gitlabConfig(`token: global-token\n${contents}`)
		cli.auth.mockImplementation(async (_command, args, options) => {
			if (args[1] === "path") return path
			expect(args).toEqual(["config", "get", "token", "--host", "gitlab.com"])
			const isolated = options.env?.GLAB_CONFIG_DIR
			expect(isolated && parseYaml(readFileSync(join(isolated, "config.yml"), "utf8"))).toEqual({
				hosts: { "gitlab.com": { use_keyring: "true" } },
			})
			return "keyring-token"
		})
		await lookup()
		expect(cli.auth).toHaveBeenCalledTimes(2)
		expect(http).toHaveBeenCalled()
		for (const [, options] of http.mock.calls)
			expect(new Headers(options.headers).get("authorization")).toBe("Bearer keyring-token")
	})
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
	it("does not use the SSH transport port as the GitLab API port", async () => {
		seed()
		remote("ssh://git@gitlab.com:22/team/subgroup/repo.git")
		replies(() => [mr()])
		await lookup()
		expect(saved().at(-1).prLookup.status).toBe("linked")
		for (const [url] of http.mock.calls) expect(url.origin).toBe("https://gitlab.com")
	})
	it("preserves a configured HTTPS port", async () => {
		seed()
		remote("https://gitlab.example:8443/team/subgroup/repo.git")
		vi.stubEnv("GITLAB_HOST", "https://gitlab.example:8443")
		replies(() => [mr(7, { web_url: "https://gitlab.example:8443/team/subgroup/repo/-/merge_requests/7" })])
		await lookup()
		expect(saved().at(-1).prLookup.status).toBe("linked")
		for (const [url] of http.mock.calls) expect(url.origin).toBe("https://gitlab.example:8443")
	})
	it("identifies a self-hosted GitLab API without guessing from its hostname", async () => {
		seed()
		remote("https://code.example/team/repo.git")
		http.mockImplementation(async (url) => {
			if (url.pathname.startsWith("/api/v3/")) return new Response("not found", { status: 404 })
			if (!url.pathname.includes("/commits/"))
				return Response.json({ id: 42, path_with_namespace: "team/repo", web_url: "https://code.example/team/repo" })
			return Response.json([mr(7, { web_url: "https://code.example/team/repo/-/merge_requests/7" })])
		})
		await lookup()
		expect(saved().at(-1).pullRequests[0]).toMatchObject({ provider: "gitlab", host: "code.example" })
	})
})

describe("bounded and safe HTTP lookup", () => {
	it.each(providers)("rejects unknown raw %s states before persisting a link", async (provider) => {
		seed()
		useProvider(provider)
		replies(() =>
			provider === "github"
				? [pull(7, { state: "unexpected", merged_at: "2026-10-02T12:00:00Z" })]
				: [mr(7, { state: "open" })],
		)
		await lookup()
		expect(saved().at(-1)).toMatchObject({ prLookup: { status: "error" }, pullRequests: [] })
	})
	it.each([
		"https://elsewhere.example/steal",
		"http://api.github.com/repos/team/repo",
		"https://api.github.com:8443/repos/team/repo",
	])("rejects redirect %s before sending another authenticated request", async (location) => {
		seed()
		cli.token.mockReturnValue("secret")
		http.mockImplementation(async () => new Response(null, { status: 302, headers: { location } }))
		await lookup()
		expect(http).toHaveBeenCalledOnce()
		expect(saved().at(-1).prLookup.error).toContain("unsafe redirect")
		expect(JSON.stringify(saved())).not.toContain("secret")
	})
	it.each([
		"https://elsewhere.example/steal?page=2",
		"https://api.github.com/repos/other/repo/pulls?page=2",
		`https://api.github.com/repos/team/repo/commits/${sha}/pulls?page=2&per_page=100&access_token=secret`,
		`https://api.github.com/repos/team/repo/commits/${sha}/pulls?page=NaN&per_page=100`,
	])("rejects untrusted pagination %s", async (next) => {
		seed()
		replies(() => Response.json([pull()], { headers: { link: `<${next}>; rel="next"` } }))
		await lookup()
		expect(commitCalls()).toHaveLength(1)
		expect(saved().at(-1).prLookup.status).toBe("error")
		expect(JSON.stringify(saved())).not.toContain("secret")
	})
	it("caps redirects even when each destination remains on the same origin", async () => {
		seed()
		http.mockImplementation(async () => new Response(null, { status: 302, headers: { location: "/again" } }))
		await lookup()
		expect(http).toHaveBeenCalledTimes(4)
		expect(saved().at(-1).prLookup.error).toContain("redirect")
	})
	it("waits for an unpublished GitHub commit and links it after push", async () => {
		seed()
		replies(() => Response.json({ message: `No commit found for SHA: ${sha}` }, { status: 422 }))
		await lookup()
		expect(saved().at(-1)).toMatchObject({ prLookup: { status: "pending" }, pullRequests: [] })
		expect(saved().at(-1).prLookup).not.toHaveProperty("error")
		replies(() => [pull()])
		await lookup()
		expect(saved().at(-1)).toMatchObject({
			prLookup: { status: "linked" },
			pullRequests: [{ number: 7 }],
		})
	})
	it.each([
		["github", "validation error", JSON.stringify({ message: "Validation Failed: secret" })],
		["github", "different commit", JSON.stringify({ message: `No commit found for SHA: ${"b".repeat(40)}` })],
		["github", "malformed JSON", "secret invalid json"],
		["gitlab", "GitHub-shaped error", JSON.stringify({ message: `No commit found for SHA: ${sha}` })],
	] as const)("keeps %s HTTP 422 %s as an error", async (provider, _description, body) => {
		seed()
		useProvider(provider)
		replies(() => new Response(body, { status: 422 }))
		await lookup()
		expect(saved().at(-1).prLookup).toMatchObject({ status: "error" })
		expect(JSON.stringify(saved())).not.toContain("secret")
	})
	it("does not treat a missing-commit message from the repository endpoint as pending", async () => {
		seed()
		http.mockImplementation(async () => Response.json({ message: `No commit found for SHA: ${sha}` }, { status: 422 }))
		await lookup()
		expect(saved().at(-1).prLookup).toMatchObject({ status: "error", error: expect.stringContaining("HTTP 422") })
	})
	it("bounds the GitHub missing-commit error body", async () => {
		seed()
		const cancel = vi.fn()
		replies(
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1))
						},
						cancel,
					}),
					{ status: 422 },
				),
		)
		await lookup()
		expect(cancel).toHaveBeenCalledOnce()
		expect(saved().at(-1).prLookup.error).toContain("lookup limit")
	})
	it("times out a stalled GitHub missing-commit error body", async () => {
		seed()
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const cancel = vi.fn()
		replies(() => new Response(new ReadableStream({ cancel }), { status: 422 }))
		const pending = lookup()
		await vi.waitFor(() => expect(http).toHaveBeenCalledTimes(2))
		await vi.advanceTimersByTimeAsync(5000)
		await pending
		expect(cancel).toHaveBeenCalledOnce()
		expect(saved().at(-1).prLookup.error).toContain("timed out")
	})
	it.each([
		[401, "authentication failed"],
		[403, "denied access"],
		[500, "HTTP 500"],
	])("records a safe retryable error for HTTP %i", async (status, message) => {
		seed()
		http.mockImplementation(async () => new Response("secret response body", { status }))
		await lookup()
		expect(saved().at(-1).prLookup).toMatchObject({ status: "error", error: expect.stringContaining(message) })
		expect(JSON.stringify(saved())).not.toContain("secret")
		replies(() => [pull()])
		await lookup()
		expect(saved().at(-1).prLookup.status).toBe("linked")
	})
	it("rejects malformed JSON without retaining the response text", async () => {
		seed()
		http.mockImplementation(async () => new Response("secret invalid json"))
		await lookup()
		expect(saved().at(-1).prLookup.error).toContain("invalid JSON")
		expect(JSON.stringify(saved())).not.toContain("secret")
	})
	it("enforces the body limit while streaming even without Content-Length", async () => {
		seed()
		const cancel = vi.fn()
		http.mockImplementation(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1))
						},
						cancel,
					}),
				),
		)
		await lookup()
		expect(cancel).toHaveBeenCalledOnce()
		expect(saved().at(-1).prLookup.error).toContain("lookup limit")
	})
	it("times out a stalled response body after five seconds", async () => {
		seed()
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const cancel = vi.fn()
		http.mockImplementation(async () => new Response(new ReadableStream({ cancel })))
		const pending = lookup()
		await vi.waitFor(() => expect(http).toHaveBeenCalledOnce())
		await vi.advanceTimersByTimeAsync(5000)
		await pending
		expect(cancel).toHaveBeenCalledOnce()
		expect(saved().at(-1).prLookup.error).toContain("timed out")
	})
	it("times out waiting for response headers after five seconds", async () => {
		seed()
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		http.mockImplementation(
			async (_url, options) =>
				new Promise((_resolve, reject) => {
					if (!options.signal) throw new Error("Missing request cancellation signal")
					options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
				}),
		)
		const pending = lookup()
		await vi.waitFor(() => expect(http).toHaveBeenCalledOnce())
		await vi.advanceTimersByTimeAsync(5000)
		await pending
		expect(saved().at(-1).prLookup.error).toContain("timed out")
	})
	it("aborts an unfinished body without publishing lookup state", async () => {
		seed()
		const cancel = vi.fn()
		const controller = new AbortController()
		http.mockImplementation(async () => new Response(new ReadableStream({ cancel })))
		const pending = lookup(controller.signal)
		const failed = expect(pending).rejects.toThrow()
		await vi.waitFor(() => expect(http).toHaveBeenCalledOnce())
		controller.abort()
		await failed
		expect(cancel).toHaveBeenCalledOnce()
		expect(() => saved()).toThrow()
	})
	it("caps the combined pages instead of accepting four megabytes per page", async () => {
		seed()
		replies((url) => {
			const next = new URL(url)
			next.searchParams.set("page", "2")
			return Response.json([pull(7, { padding: "x".repeat(2 * 1024 * 1024) })], {
				headers: url.searchParams.has("page") ? undefined : { link: `<${next.href}>; rel="next"` },
			})
		})
		await lookup()
		expect(commitCalls()).toHaveLength(2)
		expect(saved().at(-1)).toMatchObject({
			prLookup: { status: "error", error: expect.stringContaining("lookup limit") },
			pullRequests: [],
		})
	})
	it("stops all same-host requests in the current pass when rate-limited, including known links", async () => {
		seed({
			pullRequests: [stored("github", { host: "limits.example", url: "https://limits.example/team/repo/pull/7" })],
		})
		seed({ sha: "b".repeat(40) })
		remote("https://limits.example/team/repo.git")
		vi.stubEnv("GH_HOST", "limits.example")
		const now = Date.now()
		const time = vi.spyOn(Date, "now").mockReturnValue(now)
		replies(() => new Response(null, { status: 429, headers: { "retry-after": "60" } }))
		await lookup()
		expect(http).toHaveBeenCalledTimes(2)
		expect(saved().at(-1).prLookup.error).toContain("rate limit")
		await lookup()
		expect(http).toHaveBeenCalledTimes(2)
		time.mockReturnValue(now + 60_001)
		replies(() => [])
		await lookup()
		expect(http.mock.calls.length).toBeGreaterThan(2)
	})
	it("uses a successful response's exhausted quota header before fetching its next page", async () => {
		seed()
		remote("https://exhausted.example/team/repo.git")
		vi.stubEnv("GH_HOST", "exhausted.example")
		replies((url) => {
			const next = new URL(url)
			next.searchParams.set("page", "2")
			return Response.json([], {
				headers: {
					link: `<${next.href}>; rel="next"`,
					"x-ratelimit-remaining": "0",
					"x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 60),
				},
			})
		})
		await lookup()
		expect(commitCalls()).toHaveLength(1)
		expect(saved().at(-1).prLookup.error).toContain("rate limit")
	})
})

describe("durable work pull request discovery", () => {
	it("reads another process's saved links without network requests or ledger writes", () => {
		seed()
		expect(readWorkPullRequestUpdates(agentDir)[0]).toMatchObject({
			workId,
			sessionId: "writer",
			repository,
			sha,
			pullRequests: [],
		})
		seed({
			prLookup: { status: "linked", checkedAt: "2026-10-02T12:00:00Z" },
			pullRequests: [stored("github", { provider: undefined })],
		})
		const before = readFileSync(join(agentDir, "work-attribution", "source.jsonl"), "utf8")
		const latest = readWorkPullRequestUpdates(agentDir)
		expect(latest).toHaveLength(1)
		expect(latest[0]).toMatchObject({
			workId,
			sessionId: "writer",
			repository,
			sha,
			pullRequests: [{ provider: "github", number: 7 }],
		})
		expect(readFileSync(join(agentDir, "work-attribution", "source.jsonl"), "utf8")).toBe(before)
		expect(() => saved()).toThrow()
		expect(http).not.toHaveBeenCalled()
	})
	it("reads both journals and fans one request out to the original contributors after their worktree is deleted", async () => {
		seed()
		seed({ workId: otherWorkId, sessionId: "second" }, true)
		replies(() => [pull()])
		await lookup()
		expect(commitCalls()).toHaveLength(1)
		expect(cli.git.mock.calls[0][1].cwd).toBe(repository)
		for (const [sessionId, expectedWork] of [
			["writer", workId],
			["second", otherWorkId],
		]) {
			expect(saved(sessionId).at(-1)).toMatchObject({
				type: "commit",
				workId: expectedWork,
				sessionId,
				repository,
				sha,
				cwd: join(directory, "removed-worktree"),
				worktree: join(directory, "removed-worktree"),
				prLookup: { status: "linked" },
				pullRequests: [{ number: 7 }],
			})
		}
	})
	it.each(providers)("finds a later %s match and reads every page", async (provider) => {
		seed()
		useProvider(provider)
		await lookup()
		expect(saved().at(-1).prLookup.status).toBe("pending")
		replies((url) => {
			const values = provider === "github" ? [pull(), pull(8)] : [mr(), mr(8)]
			if (url.searchParams.has("page")) return [values[1], values[0]]
			const next = new URL(url)
			next.searchParams.set("page", "2")
			return Response.json([values[0]], {
				headers: provider === "github" ? { link: `<${next.href}>; rel="next"` } : { "x-next-page": "2" },
			})
		})
		await lookup()
		expect(
			saved()
				.at(-1)
				.pullRequests.map((pr: { number: number }) => pr.number),
		).toEqual([7, 8])
	})
	it.each(providers)("retains a known %s link after squash and stops rechecking merged links", async (provider) => {
		seed()
		useProvider(provider)
		replies(() => (provider === "github" ? [pull()] : [mr()]))
		await lookup()
		replies((url) => {
			if (url.pathname.includes("/commits/")) return []
			return provider === "github"
				? pull(7, {
						state: "closed",
						merged_at: "2026-10-02T12:00:00Z",
						closed_at: "2026-10-02T12:00:00Z",
						head: { sha: "b".repeat(40) },
						merge_commit_sha: "c".repeat(40),
					})
				: mr(7, { state: "merged", sha: "b".repeat(40), merge_commit_sha: "c".repeat(40) })
		})
		await lookup()
		expect(saved().at(-1)).toMatchObject({
			prLookup: { status: "linked" },
			pullRequests: [{ provider, state: "merged", headSha: "b".repeat(40), mergeCommitSha: "c".repeat(40) }],
		})
		http.mockClear()
		await lookup()
		expect(http).not.toHaveBeenCalled()
		expect(updates.at(-1)?.pullRequests[0].state).toBe("merged")
	})
	it.each([
		"opened",
		"locked",
		"closed",
		"merged",
	])("uses GitLab's %s state even when timestamps are absent", async (state) => {
		seed()
		useProvider("gitlab")
		replies(() => [mr(7, { state })])
		await lookup()
		expect(saved().at(-1).pullRequests[0]).toMatchObject({
			state: state === "opened" || state === "locked" ? "open" : state,
			mergedAt: null,
			closedAt: null,
		})
	})
	it.each([
		["github", 404],
		["gitlab", 404],
		["github", 422],
	] as const)("replays %s links after restart when the old SHA returns HTTP %i and a closed request reopens", async (provider, status) => {
		seed({ pullRequests: [stored(provider, { state: "closed", closedAt: "2026-10-01T12:00:00Z" })] })
		useProvider(provider)
		replies((url) =>
			url.pathname.includes("/commits/")
				? Response.json({ message: `No commit found for SHA: ${sha}` }, { status })
				: provider === "github"
					? pull()
					: mr(),
		)
		vi.resetModules()
		const relaunched = await import("./pull-requests.js")
		try {
			await relaunched.reconcileWorkPullRequests(agentDir, new AbortController().signal, () => {})
			expect(saved().at(-1)).toMatchObject({
				prLookup: { status: "linked" },
				pullRequests: [{ provider, state: "open", closedAt: null }],
			})
		} finally {
			await (await import("../work-attribution/summary.js")).flushWorkSummaries()
		}
	})
	it("does not publish after cancellation or loss of the reconciliation lease", async () => {
		seed()
		const controller = new AbortController()
		http.mockImplementation(async () => {
			controller.abort()
			return Response.json({})
		})
		await expect(lookup(controller.signal)).rejects.toThrow()
		expect(() => saved()).toThrow()
		replies(() => [pull()])
		await expect(
			lookup(undefined, () => {
				throw new Error("lease lost")
			}),
		).rejects.toThrow("lease lost")
		expect(() => saved()).toThrow()
	})
	it("catches up a contributor whose journal has an older state", async () => {
		seed({
			pullRequests: [
				stored("github", { state: "merged", mergedAt: "2026-10-02T12:00:00Z", checkedAt: "2026-10-02T12:00:00Z" }),
			],
		})
		seed({ workId: otherWorkId, sessionId: "second", pullRequests: [stored()] })
		replies(() => [])
		await lookup()
		expect(saved("second").at(-1).pullRequests[0].state).toBe("merged")
	})
	it("does not hide one failed known-link refresh behind another successful refresh", async () => {
		seed({ pullRequests: [stored(), stored("github", { number: 8, url: pull(8).html_url })] })
		replies((url) => (url.pathname.endsWith("/pulls/8") ? pull(8) : new Response(null, { status: 404 })))
		await lookup()
		expect(saved().at(-1).prLookup.status).toBe("error")
		expect(saved().at(-1).pullRequests).toHaveLength(2)
	})
	it("starts with waiting data and prevents overlapping network passes", async () => {
		seed()
		let finish!: () => void
		const gate = new Promise<void>((resolve) => {
			finish = resolve
		})
		replies(async () => {
			expect(updates[0]).toMatchObject({ sha, pullRequests: [] })
			expect(updates[0].prLookup).toBeUndefined()
			await gate
			return [pull()]
		})
		const first = lookup()
		const second = lookup()
		try {
			expect(first).toBe(second)
			await vi.waitFor(() => expect(commitCalls()).toHaveLength(1))
		} finally {
			finish()
		}
		await first
		expect(saved()).toHaveLength(1)
	})
	it.each([
		["pending", () => {}, { status: "pending" }],
		[
			"unsupported",
			() => {
				remote("https://git.example.com/team/repo.git")
				http.mockImplementation(async () => new Response("<html>Sign in</html>"))
			},
			{ status: "error", error: expect.stringContaining("no supported GitHub or GitLab API"), reason: "unsupported" },
		],
		[
			"missing repository",
			() =>
				http.mockImplementation(async () =>
					Response.json({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }, { status: 404 }),
				),
			{ status: "error", error: expect.stringContaining("could not find this repository") },
		],
	] as const)("checks an aging commit less often and stops checking one without a PR after the upload window: %s", async (_result, respond, result) => {
		const day = 24 * 60 * 60 * 1000
		const old = join(directory, "old.git")
		mkdirSync(old)
		seed({ recordedAt: new Date(Date.now() - day).toISOString() })
		seed({ sha: "b".repeat(40), repository: old, recordedAt: new Date(Date.now() - 60 * day).toISOString() })
		respond()
		// Every check starts by reading its repository's remote, before any provider request.
		const checked = () => cli.git.mock.calls.map(([args]) => (args[1] === old ? "old" : "recent"))
		await lookup()
		expect(checked()).toEqual(["recent", "old"])
		expect(saved().at(-1).repository).toBe(old)
		expect(saved().at(-1).prLookup).toEqual({ ...result, checkedAt: expect.any(String) })
		later()
		await lookup()
		expect(checked()).toEqual(["recent", "old"])
		later(2 * 60 * 60 * 1000)
		await lookup()
		later(day)
		await lookup()
		expect(checked()).toEqual(["recent", "old", "recent", "recent"])
	})
	it("keeps refreshing a known PR after the upload window", async () => {
		const day = 24 * 60 * 60 * 1000
		seed({
			recordedAt: new Date(Date.now() - 60 * day).toISOString(),
			prLookup: { status: "linked", checkedAt: new Date(Date.now() - 2 * day).toISOString() },
			pullRequests: [stored()],
		})
		replies((url) => (url.pathname.includes("/commits/") ? [] : pull()))
		await lookup()
		later(day)
		await lookup()
		expect(http.mock.calls.filter(([url]) => url.pathname === "/repos/team/repo/pulls/7")).toHaveLength(2)
	})
	it("retries an actionable failure saved by an earlier process once before backing off", async () => {
		const day = 24 * 60 * 60 * 1000
		seed({
			recordedAt: new Date(Date.now() - 20 * day).toISOString(),
			prLookup: {
				status: "error",
				checkedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
				error: "GitHub authentication failed. Check the token for github.com.",
			},
		})
		await lookup()
		expect(commitCalls()).toHaveLength(1)
		expect(updates.at(-1)?.prLookup).toMatchObject({ status: "pending" })
		later()
		await lookup()
		expect(commitCalls()).toHaveLength(1)
	})
	it("moves a slow commit behind other commits on the next bounded pass", async () => {
		seed()
		const otherSha = "b".repeat(40)
		seed({ sha: otherSha })
		let now = Date.now()
		vi.spyOn(Date, "now").mockImplementation(() => now)
		replies((url) => {
			if (url.pathname.includes(sha)) now += 10_001
			return []
		})
		await lookup()
		expect(commitCalls()).toHaveLength(1)
		await lookup()
		expect(commitCalls().map((url) => url.pathname)).toEqual([
			`/repos/team/repo/commits/${sha}/pulls`,
			`/repos/team/repo/commits/${otherSha}/pulls`,
			`/repos/team/repo/commits/${sha}/pulls`,
		])
	})
	it("deduplicates a commit request across separate clones", async () => {
		seed()
		const secondRepository = join(directory, "second.git")
		mkdirSync(secondRepository)
		seed({ repository: secondRepository, sessionId: "second", workId: otherWorkId })
		await lookup()
		expect(cli.git).toHaveBeenCalledTimes(2)
		expect(commitCalls()).toHaveLength(1)
		expect(saved("second").at(-1).repository).toBe(secondRepository)
	})
	it("retains known links after malformed pages", async () => {
		seed({ pullRequests: [stored()] })
		replies((url) => (url.pathname.includes("/commits/") ? { unexpected: "response" } : pull()))
		await lookup()
		expect(saved().at(-1)).toMatchObject({
			prLookup: { status: "error", error: expect.stringContaining("invalid pull request pages") },
			pullRequests: [{ number: 7 }],
		})
	})
	it("reads changed journals and does not advance its checkpoint after a failed source read", async () => {
		seed()
		const reads = vi.spyOn(summaries, "readWorkRecords")
		await lookup()
		expect(reads.mock.calls[0]).toEqual([agentDir, undefined])
		reads.mockImplementationOnce(() => {
			throw new Error("ledger unavailable")
		})
		await expect(lookup()).rejects.toThrow("ledger unavailable")
		const checkpoint = reads.mock.calls[1][1]
		await lookup()
		expect(reads.mock.calls[2][1]).toBe(checkpoint)
		expect(commitCalls()).toHaveLength(2)
	})
})

describe("PR titles and author logins", () => {
	const titled = (provider: Provider) =>
		provider === "github"
			? pull(7, { title: "Fix the login redirect", user: { login: "octocat", id: 1 } })
			: mr(7, { title: "Fix the login redirect", author: { username: "octocat", id: 1 } })
	it.each(providers)("keeps the %s title and author it already receives across a restart", async (provider) => {
		seed()
		useProvider(provider)
		replies(() => [titled(provider)])
		await lookup()
		// The repository identity and the commit's associations; display metadata needs no request of its own.
		expect(http).toHaveBeenCalledTimes(2)
		expect(saved().at(-1).pullRequests).toEqual([
			expect.objectContaining({ number: 7, title: "Fix the login redirect", author: "octocat" }),
		])
		vi.resetModules()
		const relaunched = await import("./pull-requests.js")
		expect(relaunched.readWorkPullRequestUpdates(agentDir)[0].pullRequests).toEqual([
			expect.objectContaining({ provider, number: 7, title: "Fix the login redirect", author: "octocat" }),
		])
	})
	it.each([
		["github", {}],
		["github", { title: "", user: { login: "" } }],
		["github", { title: 42, user: "octocat" }],
		["github", { title: null, user: { login: "a".repeat(256) } }],
		["gitlab", {}],
		["gitlab", { title: "", author: { username: "" } }],
		["gitlab", { title: 42, author: "octocat" }],
		["gitlab", { title: null, author: { username: "a".repeat(256) } }],
	] as const)("links a %s PR and leaves out a missing or malformed title and author: %j", async (provider, fields) => {
		seed()
		useProvider(provider)
		replies(() => [provider === "github" ? pull(7, fields) : mr(7, fields)])
		await lookup()
		const [link] = saved().at(-1).pullRequests
		expect(saved().at(-1).prLookup.status).toBe("linked")
		expect(link).toMatchObject({ provider, number: 7, state: "open" })
		expect(link).not.toHaveProperty("title")
		expect(link).not.toHaveProperty("author")
	})
	it.each(providers)("keeps reading %s links saved without them and adds them on the next check", async (provider) => {
		const id = String(provider === "github" ? pull().id : mr().id)
		// A link saved by an earlier version.
		seed({
			prLookup: { status: "linked", checkedAt: "2026-10-01T12:00:00Z" },
			pullRequests: [stored(provider, { id, repositoryId: "42" })],
		})
		useProvider(provider)
		const [before] = readWorkPullRequestUpdates(agentDir)[0].pullRequests
		expect(before).toMatchObject({ provider, id, number: 7, state: "open" })
		expect(before).not.toHaveProperty("title")
		expect(before).not.toHaveProperty("author")
		replies(() => [titled(provider)])
		await lookup()
		expect(saved().at(-1)).toMatchObject({
			prLookup: { status: "linked" },
			pullRequests: [{ id, number: 7, title: "Fix the login redirect", author: "octocat" }],
		})
	})
})

describe("self-managed GitLab credentials", () => {
	it.each([
		["GITLAB_HOST", "http://gitlab.internal.example"],
		["GITLAB_HOST", "https://example.com/gitlab"],
		["GITLAB_URI", "https://gitlab.internal.example"],
	])("does not send a GITLAB_TOKEN configured for %s=%s to gitlab.com", async (name, value) => {
		seed()
		useProvider("gitlab")
		vi.stubEnv(name, value)
		vi.stubEnv("GITLAB_TOKEN", "self-managed-token")
		replies(() => [mr()])
		await lookup()
		const sentToGitLabCom = http.mock.calls.filter(
			([url, options]) => url.host === "gitlab.com" && new Headers(options.headers).has("authorization"),
		)
		expect(sentToGitLabCom).toEqual([])
	})
	it.each(["GITLAB_HOST", "GL_HOST", "GITLAB_URI"])("keeps %s credentials on the configured host", async (name) => {
		seed()
		remote("https://gitlab.internal.example/team/repo.git")
		vi.stubEnv(name, "https://gitlab.internal.example")
		vi.stubEnv("GITLAB_TOKEN", "self-managed-token")
		await lookup()
		expect(http).toHaveBeenCalledTimes(2)
		for (const [url, options] of http.mock.calls) {
			expect(url.host).toBe("gitlab.internal.example")
			expect(url.pathname).toMatch(/^\/api\/v4\//)
			expect(new Headers(options.headers).get("authorization")).toBe("Bearer self-managed-token")
		}
	})
	it.each([
		"",
		"http://gitlab.internal.example",
		"https://example.com/gitlab",
		"https://user:pass@example.com",
	])("does not fall back from invalid GITLAB_HOST %j to a lower-priority host", async (value) => {
		seed()
		useProvider("gitlab")
		vi.stubEnv("GITLAB_HOST", value)
		vi.stubEnv("GL_HOST", "gitlab.com")
		vi.stubEnv("GITLAB_TOKEN", "self-managed-token")
		cli.token.mockReturnValue("saved-cloud-token")
		await lookup()
		expect(http).toHaveBeenCalledTimes(2)
		for (const [, options] of http.mock.calls)
			expect(new Headers(options.headers).get("authorization")).toBe("Bearer saved-cloud-token")
	})
})

describe("commits the provider has not received yet", () => {
	it.each(["404 Project Not Found", "404 Not Found"])("keeps GitLab %s as an access error", async (message) => {
		seed()
		useProvider("gitlab")
		replies(() => Response.json({ message }, { status: 404 }))
		await lookup()
		expect(saved().at(-1).prLookup.status).toBe("error")
	})
	it("does not turn a missing GitLab repository into a pending commit", async () => {
		seed()
		useProvider("gitlab")
		http.mockResolvedValue(Response.json({ message: "404 Commit Not Found" }, { status: 404 }))
		await lookup()
		expect(saved().at(-1).prLookup.status).toBe("error")
	})
	it("keeps a GitLab commit waiting when GitLab does not know the SHA yet", async () => {
		seed()
		useProvider("gitlab")
		// GitLab answers an unknown SHA on /repository/commits/:sha/merge_requests with 404 "Commit Not Found".
		replies(() => Response.json({ message: "404 Commit Not Found" }, { status: 404 }))
		await lookup()
		expect(saved().at(-1).prLookup).toMatchObject({ status: "pending" })
		expect(saved().at(-1).prLookup.error).toBeUndefined()
	})
})

describe("provider pagination links", () => {
	it.each([
		{ id: "other/repo" },
		{ sha: "b".repeat(40) },
	])("rejects changed GitLab route parameters: %j", async (changed) => {
		seed()
		useProvider("gitlab")
		replies((url) => {
			const next = new URL(url)
			next.search = new URLSearchParams({
				id: "team/subgroup/repo",
				page: "2",
				per_page: "100",
				sha,
				...changed,
			}).toString()
			return Response.json([mr()], { headers: { link: `<${next.href}>; rel="next"` } })
		})
		await lookup()
		expect(commitCalls()).toHaveLength(1)
		expect(saved().at(-1).prLookup.status).toBe("error")
	})
	it("follows GitHub's /repositories/:id next link for commit associations", async () => {
		seed()
		replies((url) => {
			if (url.pathname === `/repositories/42/commits/${sha}/pulls` && url.searchParams.get("page") === "2")
				return [pull(8)]
			const next = `https://api.github.com/repositories/42/commits/${sha}/pulls?per_page=100&page=2`
			return Response.json([pull(7)], { headers: { link: `<${next}>; rel="next", <${next}>; rel="last"` } })
		})
		await lookup()
		expect(saved().at(-1).prLookup.error).toBeUndefined()
		expect(
			saved()
				.at(-1)
				.pullRequests.map((pr: { number: number }) => pr.number),
		).toEqual([7, 8])
	})
	it("follows GitLab's next link when it repeats route parameters in the query", async () => {
		seed()
		useProvider("gitlab")
		replies((url) => {
			if (url.searchParams.get("page") === "2") return [mr(8, { id: 98008 })]
			const next = new URL(url)
			next.search = new URLSearchParams({ id: "team/subgroup/repo", page: "2", per_page: "100", sha }).toString()
			return Response.json([mr(7)], { headers: { link: `<${next.href}>; rel="next"`, "x-next-page": "2" } })
		})
		await lookup()
		expect(saved().at(-1).prLookup.error).toBeUndefined()
		expect(
			saved()
				.at(-1)
				.pullRequests.map((pr: { number: number }) => pr.number),
		).toEqual([7, 8])
	})
})

describe("repository renames", () => {
	it("keeps one link per provider PR and stops polling its old URL after the repository is renamed", async () => {
		const merged = pull(7, {
			id: 98731,
			state: "closed",
			merged_at: "2026-10-02T12:00:00Z",
			closed_at: "2026-10-02T12:00:00Z",
		})
		seed({
			prLookup: { status: "linked", checkedAt: "2026-10-01T12:00:00Z" },
			pullRequests: [
				stored("github", {
					id: "98731",
					repositoryId: "42",
					url: "https://github.com/team/old/pull/7",
					repository: "team/old",
				}),
			],
		})
		remote("https://github.com/team/old.git")
		http.mockImplementation(async (url) => {
			// GitHub redirects old-name API paths to /repositories/:id on the same origin.
			if (url.pathname === "/repos/team/old")
				return new Response(null, { status: 301, headers: { location: "https://api.github.com/repositories/42" } })
			if (url.pathname === "/repositories/42")
				return Response.json({ id: 42, full_name: "team/repo", html_url: "https://github.com/team/repo" })
			if (url.pathname === "/repos/team/old/pulls/7")
				return new Response(null, {
					status: 301,
					headers: { location: "https://api.github.com/repositories/42/pulls/7" },
				})
			if (url.pathname === "/repositories/42/pulls/7") return Response.json(merged)
			if (url.pathname === `/repos/team/repo/commits/${sha}/pulls`) return Response.json([merged])
			return new Response(null, { status: 404 })
		})
		await lookup()
		expect(
			saved()
				.at(-1)
				.pullRequests.map((pr: { id: string; url: string; state: string }) => [pr.id, pr.url, pr.state]),
		).toEqual([["98731", "https://github.com/team/repo/pull/7", "merged"]])
		http.mockClear()
		await lookup()
		expect(http).not.toHaveBeenCalled()
	})
})

describe("unchanged lookup results", () => {
	it("does not append another commit row when a pass finds the same links", async () => {
		seed()
		replies(() => [pull()])
		for (let pass = 0; pass < 3; pass++) await lookup()
		expect(saved().filter((row) => row.type === "commit")).toHaveLength(1)
	})
	it("does not append a row per commit on every pass while the provider is rate limited", async () => {
		for (let index = 0; index < 20; index++) seed({ sha: index.toString(16).padStart(40, "0") })
		http.mockImplementation(async () => new Response(null, { status: 429, headers: { "retry-after": "3600" } }))
		await lookup()
		const rows = saved().length
		for (let pass = 0; pass < 5; pass++) await lookup()
		expect(saved()).toHaveLength(rows)
	})
})

describe("saved check times", () => {
	const day = 24 * 60 * 60 * 1000
	const checks = () => JSON.parse(readFileSync(join(agentDir, "work-attribution", "pr-checks.json"), "utf8"))
	// An earlier rate-limit case pauses github.com for an hour; use a host no other case touches.
	beforeEach(() => {
		remote("https://checks.example/team/repo.git")
		vi.stubEnv("GH_HOST", "checks.example")
	})
	/** A new process: the same journals and check cache, with fresh module state. */
	async function restartedLookup(): Promise<void> {
		vi.resetModules()
		const restarted = await import("./pull-requests.js")
		try {
			await restarted.reconcileWorkPullRequests(agentDir, new AbortController().signal, () => {})
		} finally {
			await (await import("../work-attribution/summary.js")).flushWorkSummaries()
		}
	}
	it("keeps the backoff of an unchanged result across a restart", async () => {
		seed({ recordedAt: new Date().toISOString() })
		await lookup()
		later(day)
		// Due a day later; the unchanged pending result is not appended.
		await lookup()
		expect(commitCalls()).toHaveLength(2)
		later(60 * 60 * 1000)
		// One hour later, this process and a new one both wait out the backoff of about 1.6 hours.
		await lookup()
		await restartedLookup()
		expect(commitCalls()).toHaveLength(2)
		expect(saved().filter((row) => row.type === "commit")).toHaveLength(1)
		expect(checks()).toEqual({ [repository]: { [sha]: expect.any(String) } })
	})
	it("rewrites saved check times only after a change and forgets commits no longer recorded", async () => {
		const other = "b".repeat(40)
		const recordedAt = new Date(Date.now() - day).toISOString()
		seed({ recordedAt })
		seed({ sha: other, sessionId: "second", recordedAt }, true)
		await lookup()
		expect(checks()).toEqual({ [repository]: { [sha]: expect.any(String), [other]: expect.any(String) } })
		const { ino } = statSync(join(agentDir, "work-attribution", "pr-checks.json"))
		later()
		// Neither commit is due again, so the cache stays the same file.
		await lookup()
		expect(statSync(join(agentDir, "work-attribution", "pr-checks.json")).ino).toBe(ino)
		rmSync(join(agentDir, "work-attribution", "transitions"), { recursive: true })
		rmSync(join(agentDir, "work-attribution", "second.jsonl"))
		await restartedLookup()
		expect(commitCalls()).toHaveLength(2)
		expect(checks()).toEqual({ [repository]: { [sha]: expect.any(String) } })
	})
	it("drops a saved check time once it no longer delays a lookup", async () => {
		seed({ recordedAt: new Date(Date.now() - day).toISOString() })
		replies(() => [
			pull(7, {
				html_url: "https://checks.example/team/repo/pull/7",
				state: "closed",
				merged_at: "2026-10-02T12:00:00Z",
				closed_at: "2026-10-02T12:00:00Z",
			}),
		])
		await lookup()
		expect(checks()).toEqual({ [repository]: { [sha]: expect.any(String) } })
		// A merged link is settled and never checked again; its check time expires after the longest backoff.
		later(day)
		await lookup()
		expect(commitCalls()).toHaveLength(1)
		expect(checks()).toEqual({})
	})
})

describe("lookup failure reasons", () => {
	it.each([
		["an authentication failure", () => new Response(null, { status: 401 }), undefined],
		["a server error", () => new Response(null, { status: 503 }), "retry"],
		["a rate limit", () => new Response(null, { status: 429, headers: { "retry-after": "60" } }), "retry"],
		[
			"a network failure",
			() => {
				throw new TypeError("fetch failed")
			},
			"retry",
		],
		["an invalid response", () => new Response("not json"), "retry"],
	] as const)("saves %s with its reason", async (name, reply, reason) => {
		// Rate limits pause a whole host; give every case its own.
		const host = `${name.replaceAll(" ", "-")}.example`
		seed()
		remote(`https://${host}/team/repo.git`)
		vi.stubEnv("GH_HOST", host)
		http.mockImplementation(async () => reply())
		await lookup()
		expect(saved().at(-1).prLookup).toEqual({
			status: "error",
			checkedAt: expect.any(String),
			error: expect.any(String),
			...(reason ? { reason } : {}),
		})
		expect(readWorkPullRequestUpdates(agentDir)[0].prLookup?.reason).toBe(reason)
	})
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
	it("keeps the remote's own host when SSH config sends it to another address", async () => {
		seed()
		remote("git@gitlab.ssh.example:team/repo.git")
		cli.token.mockImplementation((host) => (host === "gitlab.ssh.example" ? "saved-token" : undefined))
		cli.auth.mockImplementation(async (command, args) =>
			command === "ssh" && args.join(" ") === "-G gitlab.ssh.example"
				? "user git\nhostname 10.0.0.5\nport 22\n"
				: undefined,
		)
		http.mockImplementation(async (url) => {
			// The HTTPS API is served only under the web host; the SSH address has no matching certificate.
			if (url.host !== "gitlab.ssh.example") throw new TypeError("fetch failed")
			if (url.pathname.startsWith("/api/v3/")) return new Response("not found", { status: 404 })
			if (!url.pathname.includes("/commits/"))
				return Response.json({
					id: 42,
					path_with_namespace: "team/repo",
					web_url: "https://gitlab.ssh.example/team/repo",
				})
			return Response.json([mr(7, { web_url: "https://gitlab.ssh.example/team/repo/-/merge_requests/7" })])
		})
		await lookup()
		expect(saved().at(-1).prLookup).toMatchObject({ status: "linked" })
	})
	it("resolves an SSH host alias before choosing the provider", async () => {
		seed()
		remote("git@github-work:team/repo.git")
		// Rate limits pause a whole host; use one no other case touches.
		vi.stubEnv("GH_HOST", "alias.github.example")
		cli.auth.mockImplementation(async (command, args) =>
			command === "ssh" && args.join(" ") === "-G github-work"
				? "user git\nhostname alias.github.example\nport 22\n"
				: undefined,
		)
		replies(() => [pull(7, { html_url: "https://alias.github.example/team/repo/pull/7" })])
		await lookup()
		expect(saved().at(-1).prLookup.status).toBe("linked")
		expect(commitCalls()[0].host).toBe("alias.github.example")
	})
	it("marks a repository without GitHub or GitLab as unsupported in work and branch lookups", async () => {
		seed()
		remote("https://bitbucket.org/team/repo.git")
		http.mockImplementation(async () => new Response(null, { status: 404 }))
		await lookup()
		expect(saved().at(-1).prLookup).toMatchObject({ status: "error", reason: "unsupported" })
		const failure = await lookupBranchPullRequest(repository, new AbortController().signal).catch((error) => error)
		expect(lookupFailureReason(failure)).toBe("unsupported")
	})
})
