import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "shell-quote"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolvePreMainProjectTrust } from "../../project-trust.js"
import { createToolContext } from "../__mocks__/context.js"
import { credential, requestJSON } from "../pull-request-status/provider-api.js"
import { discoverMyOpenPRs, parsePRTarget, preparePRCheckout, readPRTarget } from "./targets.js"

vi.mock("../../project-trust.js", () => ({ resolvePreMainProjectTrust: vi.fn() }))
vi.mock("../pull-request-status/provider-api.js", async (original) => ({
	...(await original()),
	credential: vi.fn(),
	requestJSON: vi.fn(),
}))

const url = "https://github.com/owner/repo/pull/7"
const record = () => ({
	number: 7,
	state: "open",
	title: "Fix",
	html_url: url,
	merge_commit_sha: null,
	merged_at: null,
	closed_at: null,
	head: { sha: "a".repeat(40), ref: "fix", repo: { clone_url: "https://github.com/author/fork.git" } },
})
const response = (value: unknown, url = new URL("https://api.github.com")) => ({
	value,
	url,
	headers: new Headers(),
	bytes: 0,
})
const paths: string[] = []

beforeEach(() => {
	vi.resetAllMocks()
	vi.stubEnv("GH_HOST", "github.com")
	vi.mocked(credential).mockResolvedValue("fixture-token")
	vi.mocked(resolvePreMainProjectTrust).mockReturnValue(true)
	vi.mocked(requestJSON).mockResolvedValue(response(record()))
})
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { force: true, recursive: true })
	vi.unstubAllEnvs()
})

describe("PR targets outside the session checkout", () => {
	it("normalizes URLs and supports enterprise hosts and GitLab subgroups", () => {
		expect(parsePRTarget(`${url}/?tab=checks#comment`).url).toBe(url)
		expect(parsePRTarget("https://git.company.test/group/subgroup/repo/-/merge_requests/42")).toMatchObject({
			number: 42,
			repository: { provider: "gitlab", host: "git.company.test", name: "group/subgroup/repo" },
		})
		expect(parsePRTarget("https://github.company.test/owner/repo/pull/7").repository.provider).toBe("github")
	})
	it.each([
		"file:///etc/passwd",
		"http://github.com/owner/repo/pull/7",
		"https://token@github.com/owner/repo/pull/7",
		"https://github.com/owner/repo/pull/0",
		"https://github.com/owner/repo/pull/9999999999999999999999",
		"https://github.com/owner/repo/pull/7/files",
	])("rejects an invalid target %s before accessing credentials", (value) => {
		expect(() => parsePRTarget(value)).toThrow()
		expect(credential).not.toHaveBeenCalled()
	})
	it("uses the PR source repository for fork checkout and push", async () => {
		const target = await readPRTarget(url, new AbortController().signal)
		expect(target).toMatchObject({
			cloneURL: "https://github.com/author/fork.git",
			branch: "fix",
			pullRequest: { url, headSha: "a".repeat(40) },
		})
	})
	it("rejects source clone credentials and cross-host source URLs", async () => {
		for (const clone_url of ["https://evil.test/repo.git", "https://token@github.com/author/fork.git"]) {
			const value = record()
			value.head.repo.clone_url = clone_url
			vi.mocked(requestJSON).mockResolvedValue(response(value))
			await expect(readPRTarget(url, new AbortController().signal)).rejects.toThrow("source branch or repository")
		}
	})
	it("prepares a clone only through nested permission-checked Bash", async () => {
		const root = mkdtempSync(join(tmpdir(), "pr-watch-checkout-"))
		paths.push(root)
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"))
		const ctx = createToolContext({ cwd: root })
		vi.mocked(ctx.executeTool).mockResolvedValue({
			toolCall: { type: "toolCall", id: "clone", name: "bash", arguments: {} },
			result: { content: [{ type: "text", text: "cloned" }], details: {} },
			isError: false,
		})
		const cwd = await preparePRCheckout(ctx, url, new AbortController().signal)
		expect(cwd).toContain("pr-watch/checkouts/")
		const input = vi.mocked(ctx.executeTool).mock.calls[0][1]
		if (!input || typeof input !== "object" || !("command" in input) || typeof input.command !== "string")
			throw new Error("Expected Bash input")
		expect(parse(input.command)).toEqual([
			"gh",
			"repo",
			"clone",
			"https://github.com/author/fork.git",
			cwd,
			"--",
			"--single-branch",
			"--branch",
			"fix",
		])
		expect(ctx.ui.confirm).not.toHaveBeenCalled()
	})
	it("reports permission denial without asking for project trust", async () => {
		const root = mkdtempSync(join(tmpdir(), "pr-watch-denied-"))
		paths.push(root)
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"))
		const ctx = createToolContext({ cwd: root })
		vi.mocked(ctx.executeTool).mockResolvedValue({
			toolCall: { type: "toolCall", id: "clone", name: "bash", arguments: {} },
			result: { content: [{ type: "text", text: "Permission denied" }], details: {} },
			isError: true,
		})
		await expect(preparePRCheckout(ctx, url, new AbortController().signal)).rejects.toThrow("Permission denied")
		expect(ctx.ui.confirm).not.toHaveBeenCalled()
	})
	it("does not reuse home-directory trust for an untrusted target", async () => {
		const root = mkdtempSync(join(tmpdir(), "pr-watch-trust-"))
		paths.push(root)
		mkdirSync(join(root, ".git"))
		const ctx = createToolContext({ cwd: root, isProjectTrusted: vi.fn(() => true) })
		vi.mocked(resolvePreMainProjectTrust).mockReturnValue(false)
		vi.mocked(ctx.ui.confirm).mockResolvedValue(false)
		await expect(preparePRCheckout(ctx, url, new AbortController().signal, root)).rejects.toThrow("Trust")
		expect(ctx.executeTool).not.toHaveBeenCalled()
		expect(ctx.ui.confirm).toHaveBeenCalledWith("Trust PR checkout?", expect.stringContaining(root), expect.anything())
		await expect(preparePRCheckout(ctx, url, new AbortController().signal, root, false)).resolves.toBe(root)
	})
})

describe("explicit discovery of my active PRs", () => {
	it("paginates authored open PRs and does not silently stop at the first page", async () => {
		vi.mocked(requestJSON).mockImplementation(async (_repo, endpoint) => {
			if (endpoint.pathname === "/user") return response({ login: "owner" })
			expect(endpoint.searchParams.get("q")).toBe("is:pr is:open author:owner")
			const page = Number(endpoint.searchParams.get("page"))
			return response({
				total_count: 103,
				incomplete_results: false,
				items: Array.from({ length: page === 1 ? 100 : 3 }, (_, i) => ({
					html_url: `https://github.com/owner/repo/pull/${(page - 1) * 100 + i + 1}`,
					pull_request: {},
				})),
			})
		})
		expect(await discoverMyOpenPRs(new AbortController().signal)).toHaveLength(103)
		expect(requestJSON).toHaveBeenCalledTimes(3)
	})
	it.each([
		{ total_count: 1001, incomplete_results: false, items: [] },
		{ total_count: 1, incomplete_results: true, items: [] },
	])("reports provider search limits instead of presenting a partial set as complete", async (value) => {
		vi.mocked(requestJSON)
			.mockResolvedValueOnce(response({ login: "owner" }))
			.mockResolvedValueOnce(response(value))
		await expect(discoverMyOpenPRs(new AbortController().signal)).rejects.toThrow(/1000|incomplete/)
	})
	it("requires an authenticated account and never guesses the author", async () => {
		vi.mocked(credential).mockResolvedValue(undefined)
		await expect(discoverMyOpenPRs(new AbortController().signal)).rejects.toThrow("Sign in")
		expect(requestJSON).not.toHaveBeenCalled()
	})
})
