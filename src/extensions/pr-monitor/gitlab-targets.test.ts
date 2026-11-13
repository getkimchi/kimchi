import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readPRSnapshot } from "./providers.js"
import { discoverMyOpenPRs, readPRTarget } from "./targets.js"

const host = "gitlab.fixture.test"
const url = `https://${host}/group/subgroup/repo/-/merge_requests/7`
const mr = {
	iid: 7,
	state: "opened",
	title: "Fix parser",
	web_url: url,
	sha: "a".repeat(40),
	source_branch: "feature",
	source_project_id: 12,
	target_project_id: 9,
	merge_commit_sha: null,
	merged_at: null,
	closed_at: null,
	head_pipeline: {
		id: 21,
		status: "failed",
		updated_at: "2026-11-13T12:00:00Z",
		web_url: `https://${host}/group/subgroup/repo/-/pipelines/21`,
	},
}

beforeEach(() => {
	vi.stubEnv("GITLAB_HOST", host)
	vi.stubEnv("GITLAB_TOKEN", "gitlab-fixture-token")
})
afterEach(() => {
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

describe("GitLab MR targets and authored discovery", () => {
	it("paginates self-hosted authored open MRs using host-bound authentication", async () => {
		const pages: string[] = []
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input, options) => {
				const endpoint = new URL(input)
				expect(endpoint.host).toBe(host)
				expect(new Headers(options.headers).get("authorization")).toBe("Bearer gitlab-fixture-token")
				if (endpoint.pathname === "/api/v4/user") return Response.json({ id: 42 })
				expect(endpoint.pathname).toBe("/api/v4/merge_requests")
				expect(endpoint.searchParams.get("scope")).toBe("created_by_me")
				expect(endpoint.searchParams.get("state")).toBe("opened")
				const page = endpoint.searchParams.get("page") ?? "1"
				pages.push(page)
				return Response.json(
					[{ web_url: url.replace("/7", page === "1" ? "/7" : "/8"), state: "opened", author: { id: 42 } }],
					{ headers: { "x-next-page": page === "1" ? "2" : "" } },
				)
			}),
		)
		expect(await discoverMyOpenPRs(new AbortController().signal, "gitlab", host)).toEqual([
			url,
			url.replace("/7", "/8"),
		])
		expect(pages).toEqual(["1", "2"])
	})

	it("refuses discovery results for a different author", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input) =>
				new URL(input).pathname.endsWith("/user")
					? Response.json({ id: 42 })
					: Response.json([{ web_url: url, state: "opened", author: { id: 99 } }]),
			),
		)
		await expect(discoverMyOpenPRs(new AbortController().signal, "gitlab", host)).rejects.toThrow(
			"outside the requested author",
		)
	})

	it("resolves a fork source and reads failed pipeline/jobs and trusted unresolved discussions by MR URL", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input, options) => {
				const endpoint = new URL(input)
				expect(endpoint.host).toBe(host)
				expect(new Headers(options.headers).get("authorization")).toBe("Bearer gitlab-fixture-token")
				if (endpoint.pathname === "/api/v4/projects/12")
					return Response.json({ http_url_to_repo: `https://${host}/person/fork.git` })
				if (endpoint.pathname.endsWith("/merge_requests/7")) return Response.json(mr)
				if (endpoint.pathname.endsWith("/jobs"))
					return Response.json([
						{
							id: 3,
							name: "Tests",
							status: "failed",
							web_url: `https://${host}/group/subgroup/repo/-/jobs/3`,
							failure_reason: "script_failure",
						},
					])
				if (endpoint.pathname.endsWith("/discussions"))
					return Response.json([
						{
							id: "thread",
							notes: [
								{
									id: 5,
									body: "Please fix",
									resolvable: true,
									resolved: false,
									author: { id: 6, username: "member" },
									updated_at: "2026-11-13T12:00:00Z",
									position: { new_path: "parser.py", new_line: 1 },
								},
							],
						},
					])
				if (endpoint.pathname.endsWith("/members/all/6")) return Response.json({ access_level: 30 })
				throw new Error(`Unexpected GitLab fixture request ${endpoint.pathname}`)
			}),
		)
		expect(await readPRTarget(url, new AbortController().signal)).toMatchObject({
			branch: "feature",
			cloneURL: `https://${host}/person/fork.git`,
			pullRequest: { url, number: 7 },
		})
		const snapshot = await readPRSnapshot("/not-a-repository", new AbortController().signal, url)
		expect(snapshot).toMatchObject({
			provider: "gitlab",
			repository: "group/subgroup/repo",
			branch: "feature",
			headSha: mr.sha,
			checks: [
				{ name: "Tests", state: "failed" },
				{ name: "Pipeline", state: "failed" },
			],
			feedback: [{ author: "member", trusted: true, path: "parser.py" }],
		})
	})
})
