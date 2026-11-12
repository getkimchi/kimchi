import { beforeEach, describe, expect, it, vi } from "vitest"
import { lookupBranchPullRequest } from "../pull-request-status/branch-status.js"
import type * as ProviderAPI from "../pull-request-status/provider-api.js"
import { pages, repositoryIdentity, requestJSON } from "../pull-request-status/provider-api.js"
import { readPRSnapshot } from "./providers.js"

vi.mock("../pull-request-status/branch-status.js", () => ({ lookupBranchPullRequest: vi.fn() }))
vi.mock("../pull-request-status/provider-api.js", async (original) => ({
	...(await original<typeof ProviderAPI>()),
	pages: vi.fn(),
	requestJSON: vi.fn(),
	repositoryIdentity: vi.fn(),
}))

const head = "a".repeat(40)
const pullRequest = {
	url: "https://github.com/owner/repo/pull/7",
	number: 7,
	state: "open" as const,
	host: "github.com",
	repository: "owner/repo",
	headSha: head,
	mergeCommitSha: null,
	mergedAt: null,
	closedAt: null,
	checkedAt: "now",
}
const result = (value: unknown) => ({
	value,
	headers: new Headers(),
	url: new URL("https://api.github.com"),
	bytes: 100,
})

beforeEach(() => {
	vi.resetAllMocks()
	vi.mocked(lookupBranchPullRequest).mockResolvedValue({ branch: "feature", pullRequest })
	vi.mocked(repositoryIdentity).mockResolvedValue({ provider: "github", host: "github.com", name: "owner/repo" })
	vi.mocked(pages).mockResolvedValue([])
	vi.mocked(requestJSON).mockImplementation(async (_remote, url) => {
		if (url.pathname.endsWith("/check-runs"))
			return result({
				total_count: 1,
				check_runs: [{ id: 1, name: "tests", status: "completed", conclusion: "failure" }],
			})
		if (url.pathname.endsWith("/status")) return result({ total_count: 0, statuses: [] })
		if (url.pathname === "/graphql")
			return result({
				data: {
					repository: {
						pullRequest: { headRefOid: head, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } },
					},
				},
			})
		throw Error(`unexpected request ${url.pathname}`)
	})
})

describe("PR provider API contracts", () => {
	it("queries review threads with a read-only GraphQL POST and current-head CI", async () => {
		const snapshot = await readPRSnapshot("/fixture", new AbortController().signal)
		expect(snapshot?.checks[0].state).toBe("failed")
		const query = vi.mocked(requestJSON).mock.calls.find((call) => call[1].pathname === "/graphql")
		expect(query?.[4]).toMatchObject({ variables: { owner: "owner", name: "repo", number: 7 } })
		expect(query?.[4]?.query).toContain("isResolved")
	})

	it("refuses partial check lists rather than silently missing failures", async () => {
		vi.mocked(requestJSON).mockImplementation(async (_remote, url) => {
			if (url.pathname.endsWith("/check-runs")) return result({ total_count: 101, check_runs: [] })
			if (url.pathname.endsWith("/status")) return result({ total_count: 0, statuses: [] })
			return result({
				data: {
					repository: {
						pullRequest: { headRefOid: head, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } },
					},
				},
			})
		})
		await expect(readPRSnapshot("/fixture", new AbortController().signal)).rejects.toThrow("complete CI check list")
	})

	it("uses the MR pipeline even when GitLab tests a different merge-result SHA", async () => {
		vi.mocked(repositoryIdentity).mockResolvedValue({ provider: "gitlab", host: "gitlab.com", name: "owner/repo" })
		vi.mocked(requestJSON).mockResolvedValue(
			result({ sha: head, head_pipeline: { id: 10, sha: "b".repeat(40), status: "failed" } }),
		)
		vi.mocked(pages).mockImplementation(async (_remote, url) =>
			url.pathname.endsWith("/jobs") ? [{ id: 1, name: "parent job", status: "success" }] : [],
		)
		const snapshot = await readPRSnapshot("/fixture", new AbortController().signal)
		expect(snapshot?.checks.map((check) => check.state)).toEqual(["passed", "failed"])
		expect(snapshot?.headSha).toBe(head)
	})
})
