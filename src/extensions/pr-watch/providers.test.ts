import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type * as ProviderAPI from "../pull-request-status/provider-api.js"
import { credential, pages, requestJSON } from "../pull-request-status/provider-api.js"
import { LookupError } from "../pull-request-status/provider-records.js"
import {
	discoverMyOpenPRs,
	githubChecks,
	githubFeedback,
	parsePRUrl,
	readPRSnapshot,
	readPRSource,
} from "./providers.js"

vi.mock("../pull-request-status/provider-api.js", async (original) => ({
	...(await original<typeof ProviderAPI>()),
	credential: vi.fn(),
	pages: vi.fn(),
	requestJSON: vi.fn(),
}))

const signal = new AbortController().signal
const head = "a".repeat(40)
const url = "https://github.com/owner/repo/pull/7"
const pull = () => ({
	number: 7,
	state: "open",
	title: "Fix",
	html_url: url,
	merge_commit_sha: null,
	merged_at: null,
	closed_at: null,
	head: { sha: head, ref: "fix", repo: { clone_url: "https://github.com/author/fork.git" } },
})
const response = (value: unknown) => ({
	value,
	url: new URL("https://api.github.com"),
	headers: new Headers(),
	bytes: 0,
})
const threads = {
	data: {
		repository: { pullRequest: { headRefOid: head, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } },
	},
}

beforeEach(() => {
	vi.resetAllMocks()
	vi.stubEnv("GH_HOST", "github.com")
	vi.mocked(credential).mockResolvedValue("fixture-token")
	vi.mocked(pages).mockResolvedValue([])
})
afterEach(() => {
	vi.unstubAllEnvs()
})

describe("PR URLs", () => {
	it("normalizes GitHub, enterprise and GitLab subgroup URLs", () => {
		expect(parsePRUrl(`${url}/?tab=checks#comment`).url).toBe(url)
		expect(parsePRUrl("https://git.company.test/group/subgroup/repo/-/merge_requests/42")).toMatchObject({
			number: 42,
			repository: { provider: "gitlab", host: "git.company.test", name: "group/subgroup/repo" },
		})
		expect(parsePRUrl("https://github.company.test/owner/repo/pull/7").repository.provider).toBe("github")
	})

	it.each([
		"not a url",
		"file:///etc/passwd",
		"http://github.com/owner/repo/pull/7",
		"https://token@github.com/owner/repo/pull/7",
		"https://github.com/owner/repo/pull/0",
		"https://github.com/owner/repo/pull/07",
		"https://github.com/owner/repo/pull/9999999999999999999999",
		"https://github.com/owner/repo/pull/7/files",
		"https://gitlab.com/project/-/merge_requests/7",
	])("rejects %s", (value) => {
		expect(() => parsePRUrl(value)).toThrow()
	})
})

describe("GitHub snapshots", () => {
	it("keeps pending, failed, skipped and external checks distinct and rejects unknown states", () => {
		const checks = githubChecks(
			[
				{ id: 1, name: "tests", status: "completed", conclusion: "failure", output: { summary: "A test failed" } },
				{ id: 2, name: "lint", status: "queued", conclusion: null },
				{ id: 3, name: "optional", status: "completed", conclusion: "neutral" },
			],
			[{ id: 4, context: "external", state: "success", target_url: "https://ci.example/job/4" }],
		)
		expect(checks.map((check) => check.state)).toEqual(["failed", "pending", "skipped", "passed"])
		expect(checks[0].summary).toBe("A test failed")
		const stale = githubChecks([{ id: 5, status: "completed", conclusion: "stale" }], [])
		expect(stale.map((check) => check.state)).toEqual(["skipped"])
		expect(() => githubChecks([{ id: 1, status: "unknown" }], [])).toThrow('unknown CI state: "unknown"')
	})

	it("drops resolved and outdated threads and trusts members and verified apps only", () => {
		const comment = {
			id: "c",
			body: "Fix it",
			url,
			updatedAt: "now",
			author: { login: "r" },
			authorAssociation: "MEMBER",
		}
		const feedback = githubFeedback(
			[
				{ id: "resolved", isResolved: true, comments: { nodes: [comment] } },
				{ id: "outdated", isOutdated: true, comments: { nodes: [comment] } },
				{ id: "member", comments: { nodes: [comment] } },
				{ id: "outsider", comments: { nodes: [{ ...comment, authorAssociation: "NONE" }] } },
				{ id: "bot", comments: { nodes: [{ ...comment, authorAssociation: "NONE", databaseId: 9 }] } },
			],
			new Set([9]),
		)
		expect(feedback.map(({ trusted }) => trusted)).toEqual([true, false, true])
	})

	it("reads the PR by URL, current-head CI and review threads through a GraphQL POST", async () => {
		vi.mocked(requestJSON).mockImplementation(async (_remote, endpoint) => {
			if (endpoint.pathname.endsWith("/pulls/7")) return response(pull())
			if (endpoint.pathname.endsWith(`/commits/${head}/check-runs`))
				return response({
					total_count: 1,
					check_runs: [{ id: 1, name: "tests", status: "completed", conclusion: "failure" }],
				})
			if (endpoint.pathname.endsWith(`/commits/${head}/status`)) return response({ total_count: 0, statuses: [] })
			if (endpoint.pathname === "/graphql") return response(threads)
			throw new Error(`unexpected ${endpoint.pathname}`)
		})
		expect(await readPRSnapshot(url, signal)).toMatchObject({
			branch: "fix",
			headSha: head,
			checks: [{ state: "failed" }],
		})
		const query = vi.mocked(requestJSON).mock.calls.find(([, endpoint]) => endpoint.pathname === "/graphql")
		expect(query?.[4]).toMatchObject({ variables: { owner: "owner", name: "repo", number: 7 } })
	})

	it("refuses a partial check list rather than missing failures", async () => {
		vi.mocked(requestJSON).mockImplementation(async (_remote, endpoint) => {
			if (endpoint.pathname.endsWith("/pulls/7")) return response(pull())
			if (endpoint.pathname.endsWith("/check-runs")) return response({ total_count: 101, check_runs: [] })
			if (endpoint.pathname.endsWith("/status")) return response({ total_count: 0, statuses: [] })
			return response(threads)
		})
		await expect(readPRSnapshot(url, signal)).rejects.toThrow("complete CI check list")
	})

	it("clones the PR's source fork and rejects credentialed or cross-host clone URLs", async () => {
		vi.mocked(requestJSON).mockResolvedValue(response(pull()))
		expect(await readPRSource(url, signal)).toMatchObject({
			cloneURL: "https://github.com/author/fork.git",
			branch: "fix",
		})
		for (const clone_url of ["https://evil.test/repo.git", "https://token@github.com/author/fork.git"]) {
			const value = pull()
			value.head.repo.clone_url = clone_url
			vi.mocked(requestJSON).mockResolvedValue(response(value))
			await expect(readPRSource(url, signal)).rejects.toThrow("source branch or repository")
		}
	})
})

describe("GitLab snapshots", () => {
	const host = "gitlab.fixture.test"
	const mrURL = `https://${host}/group/subgroup/repo/-/merge_requests/7`
	const mr = {
		iid: 7,
		state: "opened",
		web_url: mrURL,
		sha: head,
		source_branch: "feature",
		source_project_id: 12,
		merge_commit_sha: null,
		merged_at: null,
		closed_at: null,
		head_pipeline: { id: 21, sha: "b".repeat(40), status: "failed", updated_at: "now" },
	}

	it("reads a fork MR's jobs, parent pipeline and Developer-trusted discussions", async () => {
		vi.mocked(requestJSON).mockImplementation(async (_remote, endpoint) => {
			if (endpoint.pathname === "/api/v4/projects/12")
				return response({ http_url_to_repo: `https://${host}/person/fork.git` })
			if (endpoint.pathname.endsWith("/merge_requests/7")) return response(mr)
			if (endpoint.pathname.endsWith("/members/all/6")) return response({ access_level: 30 })
			throw new Error("not a member")
		})
		const note = (id: number, author: number) => ({
			id,
			body: "Please fix",
			resolvable: true,
			resolved: false,
			author: { id: author, username: `user${author}` },
			position: { new_path: "parser.py", new_line: 1 },
		})
		vi.mocked(pages).mockImplementation(async (_remote, endpoint) =>
			endpoint.pathname.endsWith("/jobs")
				? [
						{ id: 3, name: "Tests", status: "failed" },
						{ id: 4, name: "Optional", status: "failed", allow_failure: true },
						{ id: 5, name: "Deploy", status: "waiting_for_resource" },
					]
				: [
						{ id: "a", notes: [note(5, 6)] },
						{ id: "b", notes: [note(8, 7)] },
					],
		)
		expect(await readPRSource(mrURL, signal)).toMatchObject({ cloneURL: `https://${host}/person/fork.git` })
		expect(await readPRSnapshot(mrURL, signal)).toMatchObject({
			provider: "gitlab",
			repository: "group/subgroup/repo",
			headSha: head,
			checks: [
				{ name: "Tests", state: "failed" },
				{ name: "Optional", state: "skipped" },
				{ name: "Deploy", state: "pending" },
				{ name: "Pipeline", state: "failed" },
			],
			feedback: [
				{ author: "user6", trusted: true },
				{ author: "user7", trusted: false },
			],
		})
	})

	it("keeps reading CI when a membership check times out, without trusting the reviewer", async () => {
		vi.mocked(requestJSON).mockImplementation(async (_remote, endpoint) => {
			if (endpoint.pathname.endsWith("/merge_requests/7")) return response(mr)
			throw new LookupError("GitLab timed out.", "retry")
		})
		const note = { id: 5, body: "Fix it", resolvable: true, resolved: false, author: { id: 6, username: "member" } }
		vi.mocked(pages).mockImplementation(async (_remote, endpoint) =>
			endpoint.pathname.endsWith("/jobs") ? [{ id: 3, name: "Tests", status: "failed" }] : [{ id: "a", notes: [note] }],
		)
		expect(await readPRSnapshot(mrURL, signal)).toMatchObject({
			checks: [{ name: "Tests", state: "failed" }, { name: "Pipeline" }],
			feedback: [{ author: "member", trusted: false }],
		})
	})
})

describe("discovering my open PRs", () => {
	it("pages through GitHub search instead of stopping at the first page", async () => {
		vi.mocked(requestJSON).mockImplementation(async (_remote, endpoint) => {
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
		expect(await discoverMyOpenPRs("github", undefined, signal)).toHaveLength(103)
	})

	it.each([
		[{ total_count: 1001, incomplete_results: false, items: [] }, "1000"],
		[{ total_count: 1, incomplete_results: true, items: [] }, "incomplete"],
	])("reports search limits instead of a partial set", async (value, error) => {
		vi.mocked(requestJSON)
			.mockResolvedValueOnce(response({ login: "owner" }))
			.mockResolvedValueOnce(response(value))
		await expect(discoverMyOpenPRs("github", undefined, signal)).rejects.toThrow(error)
	})

	it("requires a signed-in account", async () => {
		vi.mocked(credential).mockResolvedValue(undefined)
		await expect(discoverMyOpenPRs("github", undefined, signal)).rejects.toThrow("Sign in")
		expect(requestJSON).not.toHaveBeenCalled()
	})

	it("lists GitLab MRs authored by the signed-in user on the requested host only", async () => {
		const host = "gitlab.fixture.test"
		const mine = (number: number, author = 42) => ({
			web_url: `https://${host}/group/repo/-/merge_requests/${number}`,
			state: "opened",
			author: { id: author },
		})
		vi.mocked(requestJSON).mockResolvedValue(response({ id: 42 }))
		vi.mocked(pages).mockResolvedValue([mine(7), mine(8)])
		expect(await discoverMyOpenPRs("gitlab", host, signal)).toEqual([
			`https://${host}/group/repo/-/merge_requests/7`,
			`https://${host}/group/repo/-/merge_requests/8`,
		])
		vi.mocked(pages).mockResolvedValue([mine(9, 99)])
		await expect(discoverMyOpenPRs("gitlab", host, signal)).rejects.toThrow("outside the requested author")
	})
})
