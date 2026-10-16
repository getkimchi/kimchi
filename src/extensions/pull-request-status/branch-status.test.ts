import type { ExecFileOptions } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parse as parseYaml } from "yaml"
import { lookupBranchPullRequest } from "./branch-status.js"
import { lookupFailureReason } from "./provider-records.js"

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
function pull(number = 7, overrides: Record<string, unknown> = {}) {
	return {
		id: 98000 + number,
		html_url: `https://github.com/team/repo/pull/${number}`,
		number,
		state: "open",
		head: { sha, ref: "feature" },
		merged_at: null,
		...overrides,
	}
}
function mr(number = 7, overrides: Record<string, unknown> = {}) {
	return {
		id: 98724 + number,
		iid: number,
		web_url: `https://gitlab.com/team/subgroup/repo/-/merge_requests/${number}`,
		state: "opened",
		source_branch: "feature",
		source_project_id: 42,
		...overrides,
	}
}
function lookup(signal = new AbortController().signal) {
	return lookupBranchPullRequest(repository, signal)
}
/** The lookup's error, which the footer turns into its status. */
function failure(signal?: AbortSignal): Promise<Error> {
	return lookup(signal).then(
		(value) => {
			throw new Error(`Expected the lookup to fail, got ${JSON.stringify(value)}`)
		},
		(error: Error) => error,
	)
}
function pullRequestCalls(): URL[] {
	return http.mock.calls.map(([url]) => url).filter((url) => /\/(?:pulls|merge_requests)$/.test(url.pathname))
}
function replies(handler: (url: URL, options: RequestInit) => unknown = () => []): void {
	http.mockImplementation(async (url, options) => {
		const github = /^\/(?:api\/v3\/)?repos\/([^/]+\/[^/]+)$/.exec(url.pathname)
		const gitlab = /^\/api\/v4\/projects\/([^/]+)$/.exec(url.pathname)
		const value = github
			? {
					id: 42,
					full_name: github[1],
					html_url: `https://${url.host === "api.github.com" ? "github.com" : url.host}/${github[1]}`,
				}
			: gitlab
				? {
						id: 42,
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
function authorizations(): (string | null)[] {
	return http.mock.calls.map(([, options]) => new Headers(options.headers).get("authorization"))
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
	directory = mkdtempSync(join(tmpdir(), "kimchi-branch-status-"))
	repository = join(directory, "repo")
	mkdirSync(repository)
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

describe("provider credentials", () => {
	it.each(providers)("uses a saved %s token without a CLI", async (provider) => {
		useProvider(provider)
		cli.token.mockImplementation((host) => (host === `${provider}.com` ? "saved-test-token" : undefined))
		cli.auth.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }))
		replies(() => (provider === "github" ? [pull()] : [mr()]))
		expect(await lookup()).toMatchObject({
			branch: "feature",
			pullRequest: {
				provider,
				number: 7,
				state: "open",
				repository: provider === "github" ? "team/repo" : "team/subgroup/repo",
			},
		})
		expect(pullRequestCalls()[0].pathname).toBe(
			provider === "github" ? "/repos/team/repo/pulls" : "/api/v4/projects/team%2Fsubgroup%2Frepo/merge_requests",
		)
		expect(authorizations().every((value) => value === "Bearer saved-test-token")).toBe(true)
		expect(cli.auth).not.toHaveBeenCalled()
	})
	it.each(providers)("reads a public %s repository without credentials or CLI", async (provider) => {
		useProvider(provider)
		cli.auth.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }))
		expect(await lookup()).toEqual({ branch: "feature", pullRequest: undefined })
		expect(http).toHaveBeenCalledTimes(2)
		expect(authorizations()).toEqual([null, null])
	})
	it.each(providers)("prefers the host-bound %s environment token over saved and CLI tokens", async (provider) => {
		useProvider(provider)
		vi.stubEnv(provider === "github" ? "GH_TOKEN" : "GITLAB_TOKEN", "environment-test-token")
		cli.token.mockReturnValue("saved-alternative")
		cli.auth.mockResolvedValue("cli-alternative")
		await lookup()
		expect(cli.token).not.toHaveBeenCalled()
		expect(cli.auth).not.toHaveBeenCalled()
		expect(authorizations().every((value) => value === "Bearer environment-test-token")).toBe(true)
	})
	it.each(providers)("uses only the selected host's %s CLI token without CLI side effects", async (provider) => {
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
		expect(authorizations().every((value) => value === "Bearer cli-test-token")).toBe(true)
	})
	it.each(providers)("does not switch identities after %s rejects a direct token", async (provider) => {
		useProvider(provider)
		vi.stubEnv(provider === "github" ? "GH_TOKEN" : "GITLAB_TOKEN", "rejected-secret")
		cli.token.mockReturnValue("saved-alternative")
		cli.auth.mockResolvedValue("cli-alternative")
		http.mockImplementation(async () => new Response("secret server text", { status: 401 }))
		const error = await failure()
		expect(error.message).toContain("authentication failed")
		expect(error.message).not.toContain("secret")
		expect(http).toHaveBeenCalledOnce()
		expect(cli.token).not.toHaveBeenCalled()
		expect(cli.auth).not.toHaveBeenCalled()
	})
	it("never sends a cloud GitHub token to the explicitly configured Enterprise host", async () => {
		remote("https://enterprise.example/team/repo.git")
		vi.stubEnv("GH_HOST", "enterprise.example")
		vi.stubEnv("GH_TOKEN", "cloud-secret")
		vi.stubEnv("GH_ENTERPRISE_TOKEN", "enterprise-token")
		await lookup()
		expect(http).toHaveBeenCalled()
		for (const [url, options] of http.mock.calls) {
			expect(url.origin).toBe("https://enterprise.example")
			expect(new Headers(options.headers).get("authorization")).toBe("Bearer enterprise-token")
		}
	})
	it("keeps a cloud GitHub token on github.com even when GH_HOST names another host", async () => {
		vi.stubEnv("GH_HOST", "enterprise.example")
		vi.stubEnv("GH_TOKEN", "cloud-token")
		vi.stubEnv("GH_ENTERPRISE_TOKEN", "enterprise-secret")
		await lookup()
		expect(authorizations().every((value) => value === "Bearer cloud-token")).toBe(true)
	})
	it("does not reuse another GitLab host's environment token", async () => {
		useProvider("gitlab")
		vi.stubEnv("GITLAB_HOST", "other.example")
		vi.stubEnv("GITLAB_TOKEN", "other-host-secret")
		await lookup()
		expect(authorizations().every((value) => value === null)).toBe(true)
	})
	it("never sends an unscoped GitLab global token to a different host", async () => {
		remote("https://other.example.test/team/repo.git")
		vi.stubEnv("GITLAB_HOST", "other.example.test")
		// glab config get --host falls back to its unscoped global token when this host is absent.
		const path = gitlabConfig("host: gitlab.com\ntoken: global-gitlab-com-token\n")
		cli.auth.mockImplementation(async (_command, args) => (args[1] === "path" ? path : "global-gitlab-com-token"))
		await lookup()
		expect(authorizations().every((value) => value === null)).toBe(true)
		expect(cli.auth.mock.calls.map(([, args]) => args)).toEqual([["config", "path"]])
	})
	it.each([
		"hosts:\n  other.example.test:\n    token: other-host-token\n",
		"hosts:\n  gitlab.com:\n    token: 123\n",
		"hosts:\n  gitlab.com:\n    use_keyring: false\n",
		"hosts:\n  gitlab.com:\n    use_keyring: 'false'\n",
		"hosts: [\n",
	])("does not use glab fallback credentials without a valid scoped token: %s", async (contents) => {
		useProvider("gitlab")
		cli.auth.mockResolvedValue(gitlabConfig(`token: global-token\n${contents}`))
		expect(await lookup()).toEqual({ branch: "feature", pullRequest: undefined })
		expect(authorizations().every((value) => value === null)).toBe(true)
	})
	it("uses the exact GitLab host token while ignoring global and other host tokens", async () => {
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
		expect(temporary && existsSync(temporary)).toBe(false)
		expect(readFileSync(path, "utf8")).toBe(original)
		expect(authorizations().every((value) => value === (found ? "Bearer keyring-token" : null))).toBe(true)
	})
	it("cleans up the isolated glab keyring config when lookup is cancelled", async () => {
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
	})
	it.each([
		["prints its help, as glab 1.73 and 1.75-1.114 do", "Manage key/value strings.\n\n  Current respected settings:"],
		["is an unknown command, as glab 1.72 and older", undefined],
	])("finds an older glab's login when `glab config path` %s", async (_case, output) => {
		useProvider("gitlab")
		glabHome(".config/glab-cli", "older-glab-token")
		cli.auth.mockImplementation(async (_command, args) => (args[1] === "path" ? output : "unexpected-command-token"))
		await lookup()
		expect(cli.auth.mock.calls.map(([, args]) => args)).toEqual([["config", "path"]])
		expect(http).toHaveBeenCalled()
		expect(authorizations().every((value) => value === "Bearer older-glab-token")).toBe(true)
	})
	it.each([
		["GLAB_CONFIG_DIR", "custom-token"],
		["~/.config ahead of XDG_CONFIG_HOME, as glab 1.76+", "legacy-token"],
		["XDG_CONFIG_HOME", "xdg-token"],
		["Application Support on macOS", "app-support-token"],
	])("reads an older glab's login from %s", async (location, token) => {
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
		expect(authorizations().every((value) => value === `Bearer ${token}`)).toBe(true)
	})
	it.each([
		"hosts:\n  gitlab.com: {}\n",
		"hosts:\n  gitlab.com:\n    git_protocol: ssh\n",
		"hosts:\n  gitlab.com:\n    token:\n",
		"hosts:\n  gitlab.com:\n    token: ''\n",
	])("asks the keyring for a login that glab before 1.84 saved without a token: %s", async (contents) => {
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
		expect(authorizations().every((value) => value === "Bearer keyring-token")).toBe(true)
	})
})

describe("self-managed GitLab credentials", () => {
	it.each([
		["GITLAB_HOST", "http://gitlab.internal.example"],
		["GITLAB_HOST", "https://example.com/gitlab"],
		["GITLAB_URI", "https://gitlab.internal.example"],
	])("does not send a GITLAB_TOKEN configured for %s=%s to gitlab.com", async (name, value) => {
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
		useProvider("gitlab")
		vi.stubEnv("GITLAB_HOST", value)
		vi.stubEnv("GL_HOST", "gitlab.com")
		vi.stubEnv("GITLAB_TOKEN", "self-managed-token")
		cli.token.mockReturnValue("saved-cloud-token")
		await lookup()
		expect(http).toHaveBeenCalledTimes(2)
		expect(authorizations().every((value) => value === "Bearer saved-cloud-token")).toBe(true)
	})
})

describe("repository and branch selection", () => {
	it.each(providers)("shows the current %s branch's PR", async (provider) => {
		useProvider(provider)
		replies(() => (provider === "github" ? [pull()] : [mr()]))
		expect(await lookup()).toMatchObject({ branch: "feature", pullRequest: { provider, number: 7, state: "open" } })
	})
	it.each([
		["github", "closed", { merged_at: "2026-10-02T12:00:00Z" }, "merged"],
		["github", "closed", {}, "closed"],
		["gitlab", "opened", {}, "open"],
		["gitlab", "locked", {}, "open"],
		["gitlab", "closed", {}, "closed"],
		["gitlab", "merged", {}, "merged"],
	] as const)("names a %s %s PR as %s", async (provider, state, fields, shown) => {
		useProvider(provider)
		replies(() => [provider === "github" ? pull(7, { state, ...fields }) : mr(7, { state, ...fields })])
		expect((await lookup())?.pullRequest?.state).toBe(shown)
	})
	it("resolves the renamed repository before using an exact numeric branch filter", async () => {
		remote("https://github.com/old/repo.git", "1320")
		http.mockImplementation(async (url) => {
			if (url.pathname === "/repos/old/repo")
				return new Response(null, { status: 301, headers: { location: "/repos/renamed/repo" } })
			if (url.pathname === "/repos/renamed/repo")
				return Response.json({ full_name: "renamed/repo", html_url: "https://github.com/renamed/repo" })
			expect(url.pathname).toBe("/repos/renamed/repo/pulls")
			expect(url.searchParams.get("head")).toBe("renamed:1320")
			return Response.json([
				pull(7, { html_url: "https://github.com/renamed/repo/pull/7", head: { sha, ref: "1320" } }),
			])
		})
		expect(await lookup()).toMatchObject({ branch: "1320", pullRequest: { number: 7, repository: "renamed/repo" } })
	})
	it("uses the branch's upstream remote before origin when several remotes exist", async () => {
		remote(
			"https://github.com/wrong/repo.git",
			"feature",
			"remote.upstream.url https://github.com/team/repo.git\nbranch.feature.remote upstream\n",
		)
		replies(() => [pull()])
		await lookup()
		expect(http.mock.calls[0][0].pathname).toBe("/repos/team/repo")
	})
	it("stays quiet outside a repository or on a detached HEAD", async () => {
		cli.git.mockResolvedValue(undefined)
		expect(await lookup()).toBeUndefined()
		expect(http).not.toHaveBeenCalled()
		expect(cli.auth).not.toHaveBeenCalled()
	})
	it.each(["feature", "1320"])("treats branch %s without a PR as an ordinary empty result", async (branch) => {
		remote(undefined, branch)
		expect(await lookup()).toEqual({ branch, pullRequest: undefined })
	})
	it("rejects a GitHub result for another branch", async () => {
		replies(() => [pull(7, { head: { sha, ref: "wrong" } })])
		expect((await failure()).message).toContain("different branch")
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
		expect(await lookup()).toMatchObject({ pullRequest: { provider: "gitlab", number: 7 } })
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
		expect(await lookup()).toMatchObject({ pullRequest: { provider: "gitlab", number: 7 } })
		expect(pullRequestCalls().map((url) => url.searchParams.has("with_labels_details"))).toEqual([false, false])
	})
	it("follows GitLab's next link when it repeats the project route in the query", async () => {
		useProvider("gitlab")
		replies((url) => {
			if (url.searchParams.get("page") === "2") return [mr()]
			const next = new URL(url)
			next.searchParams.set("id", "team/subgroup/repo")
			next.searchParams.set("page", "2")
			return Response.json([mr(8, { source_project_id: 99 })], { headers: { link: `<${next.href}>; rel="next"` } })
		})
		expect(await lookup()).toMatchObject({ pullRequest: { number: 7 } })
	})
	it("does not display another GitLab project's same-name branch when no local-source MR exists", async () => {
		useProvider("gitlab")
		replies(() => [mr(8, { source_project_id: 99 })])
		expect(await lookup()).toEqual({ branch: "feature", pullRequest: undefined })
	})
	it("discards a result when checkout changes during the request", async () => {
		replies(() => {
			remote(undefined, "other")
			return [pull()]
		})
		expect(await lookup()).toBeUndefined()
	})
	it("does not use the SSH transport port as the GitLab API port", async () => {
		remote("ssh://git@gitlab.com:22/team/subgroup/repo.git")
		replies(() => [mr()])
		expect(await lookup()).toMatchObject({ pullRequest: { number: 7 } })
		for (const [url] of http.mock.calls) expect(url.origin).toBe("https://gitlab.com")
	})
	it("preserves a configured HTTPS port", async () => {
		remote("https://gitlab.example:8443/team/subgroup/repo.git")
		vi.stubEnv("GITLAB_HOST", "https://gitlab.example:8443")
		replies(() => [mr(7, { web_url: "https://gitlab.example:8443/team/subgroup/repo/-/merge_requests/7" })])
		expect(await lookup()).toMatchObject({ pullRequest: { number: 7 } })
		for (const [url] of http.mock.calls) expect(url.origin).toBe("https://gitlab.example:8443")
	})
	it("identifies a self-hosted GitLab API without guessing from its hostname", async () => {
		remote("https://code.example/team/repo.git")
		http.mockImplementation(async (url) => {
			if (url.pathname.startsWith("/api/v3/")) return new Response("not found", { status: 404 })
			if (!url.pathname.endsWith("/merge_requests"))
				return Response.json({ id: 42, path_with_namespace: "team/repo", web_url: "https://code.example/team/repo" })
			return Response.json([mr(7, { web_url: "https://code.example/team/repo/-/merge_requests/7" })])
		})
		expect(await lookup()).toMatchObject({ pullRequest: { provider: "gitlab", number: 7, repository: "team/repo" } })
	})
	it("keeps the remote's own host when SSH config sends it to another address", async () => {
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
			if (!url.pathname.endsWith("/merge_requests"))
				return Response.json({
					id: 42,
					path_with_namespace: "team/repo",
					web_url: "https://gitlab.ssh.example/team/repo",
				})
			return Response.json([mr(7, { web_url: "https://gitlab.ssh.example/team/repo/-/merge_requests/7" })])
		})
		expect(await lookup()).toMatchObject({ pullRequest: { provider: "gitlab", number: 7 } })
	})
	it("resolves an SSH host alias before choosing the provider", async () => {
		remote("git@github-work:team/repo.git")
		// Rate limits pause a whole host; use one no other case touches.
		vi.stubEnv("GH_HOST", "alias.github.example")
		cli.auth.mockImplementation(async (command, args) =>
			command === "ssh" && args.join(" ") === "-G github-work"
				? "user git\nhostname alias.github.example\nport 22\n"
				: undefined,
		)
		replies(() => [pull(7, { html_url: "https://alias.github.example/team/repo/pull/7" })])
		expect(await lookup()).toMatchObject({ pullRequest: { number: 7 } })
		expect(pullRequestCalls()[0].host).toBe("alias.github.example")
	})
})

describe("bounded and safe HTTP lookup", () => {
	it.each(providers)("rejects an unknown raw %s state", async (provider) => {
		useProvider(provider)
		replies(() =>
			provider === "github"
				? [pull(7, { state: "unexpected", merged_at: "2026-10-02T12:00:00Z" })]
				: [mr(7, { state: "open" })],
		)
		expect((await failure()).message).toContain("invalid pull request state")
	})
	it("rejects a PR link into another host", async () => {
		replies(() => [pull(7, { html_url: "https://elsewhere.example/team/repo/pull/7" })])
		expect((await failure()).message).toContain("unexpected repository")
	})
	it.each([
		"https://elsewhere.example/steal",
		"http://api.github.com/repos/team/repo",
		"https://api.github.com:8443/repos/team/repo",
	])("rejects redirect %s before sending another authenticated request", async (location) => {
		cli.token.mockReturnValue("secret")
		http.mockImplementation(async () => new Response(null, { status: 302, headers: { location } }))
		const error = await failure()
		expect(http).toHaveBeenCalledOnce()
		expect(error.message).toContain("unsafe redirect")
		expect(error.message).not.toContain("secret")
	})
	it.each([
		"https://elsewhere.example/steal?page=2",
		"https://gitlab.com/api/v4/projects/other%2Frepo/merge_requests?page=2",
		"SAME_ROUTE?access_token=secret&page=2",
		"SAME_ROUTE?page=NaN",
	])("rejects untrusted GitLab pagination %s", async (template) => {
		useProvider("gitlab")
		replies((url) => {
			const next = template.startsWith("SAME_ROUTE")
				? `${url.origin}${url.pathname}${template.slice("SAME_ROUTE".length)}&${url.searchParams}`
				: template
			return Response.json([mr(8, { source_project_id: 99 })], { headers: { link: `<${next}>; rel="next"` } })
		})
		const error = await failure()
		expect(pullRequestCalls()).toHaveLength(1)
		expect(error.message).toMatch(/pagination|unsafe/)
		expect(error.message).not.toContain("secret")
	})
	it("caps redirects even when each destination remains on the same origin", async () => {
		http.mockImplementation(async () => new Response(null, { status: 302, headers: { location: "/again" } }))
		expect((await failure()).message).toContain("redirect")
		expect(http).toHaveBeenCalledTimes(4)
	})
	it.each([
		[401, "authentication failed"],
		[403, "denied access"],
		[500, "HTTP 500"],
	])("reports HTTP %i without the response text", async (status, message) => {
		http.mockImplementation(async () => new Response("secret response body", { status }))
		const error = await failure()
		expect(error.message).toContain(message)
		expect(error.message).not.toContain("secret")
	})
	it.each(["404 Project Not Found", "404 Not Found"])("keeps GitLab %s as an access error", async (message) => {
		useProvider("gitlab")
		replies(() => Response.json({ message }, { status: 404 }))
		const error = await failure()
		expect(error.message).toContain("could not find this repository or pull request")
		expect(lookupFailureReason(error)).toBeUndefined()
	})
	it("rejects malformed JSON without keeping the response text", async () => {
		http.mockImplementation(async () => new Response("secret invalid json"))
		const error = await failure()
		expect(error.message).toContain("invalid JSON")
		expect(error.message).not.toContain("secret")
	})
	it("enforces the body limit while streaming even without Content-Length", async () => {
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
		expect((await failure()).message).toContain("lookup limit")
		expect(cancel).toHaveBeenCalledOnce()
	})
	it("times out a stalled response body after five seconds", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const cancel = vi.fn()
		http.mockImplementation(async () => new Response(new ReadableStream({ cancel })))
		const pending = failure()
		await vi.waitFor(() => expect(http).toHaveBeenCalledOnce())
		await vi.advanceTimersByTimeAsync(5000)
		expect((await pending).message).toContain("timed out")
		expect(cancel).toHaveBeenCalledOnce()
	})
	it("times out waiting for response headers after five seconds", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		http.mockImplementation(
			async (_url, options) =>
				new Promise((_resolve, reject) => {
					if (!options.signal) throw new Error("Missing request cancellation signal")
					options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
				}),
		)
		const pending = failure()
		await vi.waitFor(() => expect(http).toHaveBeenCalledOnce())
		await vi.advanceTimersByTimeAsync(5000)
		expect((await pending).message).toContain("timed out")
	})
	it("aborts an unfinished body when the footer cancels the lookup", async () => {
		const cancel = vi.fn()
		const controller = new AbortController()
		http.mockImplementation(async () => new Response(new ReadableStream({ cancel })))
		const pending = lookup(controller.signal)
		const failed = expect(pending).rejects.toThrow()
		await vi.waitFor(() => expect(http).toHaveBeenCalledOnce())
		controller.abort()
		await failed
		expect(cancel).toHaveBeenCalledOnce()
	})
	it("caps the combined GitLab pages instead of accepting four megabytes per page", async () => {
		useProvider("gitlab")
		replies((url) =>
			Response.json([mr(8, { source_project_id: 99, padding: "x".repeat(2 * 1024 * 1024) })], {
				headers: url.searchParams.has("page") ? undefined : { "x-next-page": "2" },
			}),
		)
		expect((await failure()).message).toContain("lookup limit")
		expect(pullRequestCalls()).toHaveLength(2)
	})
	it("stops same-host requests while rate-limited and resumes after the limit resets", async () => {
		remote("https://limits.example/team/repo.git")
		vi.stubEnv("GH_HOST", "limits.example")
		const now = Date.now()
		const time = vi.spyOn(Date, "now").mockReturnValue(now)
		http.mockImplementation(async () => new Response(null, { status: 429, headers: { "retry-after": "60" } }))
		expect((await failure()).message).toContain("rate limit")
		expect(http).toHaveBeenCalledOnce()
		expect((await failure()).message).toContain("rate limit")
		expect(http).toHaveBeenCalledOnce()
		time.mockReturnValue(now + 60_001)
		replies(() => [])
		expect(await lookup()).toEqual({ branch: "feature", pullRequest: undefined })
		expect(http.mock.calls.length).toBeGreaterThan(1)
	})
	it("uses a successful response's exhausted quota header before fetching its next page", async () => {
		remote("https://exhausted.example/team/repo.git")
		vi.stubEnv("GITLAB_HOST", "https://exhausted.example")
		replies(() =>
			Response.json([], {
				headers: {
					"x-next-page": "2",
					"ratelimit-remaining": "0",
					"ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 60),
				},
			}),
		)
		expect((await failure()).message).toContain("rate limit")
		expect(pullRequestCalls()).toHaveLength(1)
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
	] as const)("classifies %s", async (name, reply, reason) => {
		// Rate limits pause a whole host; give every case its own.
		const host = `${name.replaceAll(" ", "-")}.example`
		remote(`https://${host}/team/repo.git`)
		vi.stubEnv("GH_HOST", host)
		http.mockImplementation(async () => reply())
		expect(lookupFailureReason(await failure())).toBe(reason)
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
		expect(lookupFailureReason(await failure())).toBe("unsupported")
	})
	it("keeps a self-hosted GitLab's own 404 actionable without GITLAB_HOST", async () => {
		remote("https://gitlab.corp.example/team/repo.git")
		vi.stubEnv("GITLAB_TOKEN", "gitlab-com-token")
		http.mockImplementation(async () => Response.json({ message: "404 Project Not Found" }, { status: 404 }))
		const error = await failure()
		expect({ message: error.message, reason: lookupFailureReason(error) }).toEqual({
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
		const error = await failure()
		expect({ message: error.message, reason: lookupFailureReason(error) }).toEqual({
			message: expect.stringContaining("GitLab authentication failed"),
			reason: undefined,
		})
	})
	it("marks a repository without GitHub or GitLab as unsupported", async () => {
		remote("https://bitbucket.org/team/repo.git")
		http.mockImplementation(async () => new Response(null, { status: 404 }))
		expect(lookupFailureReason(await failure())).toBe("unsupported")
	})
})
