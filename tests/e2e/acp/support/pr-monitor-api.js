import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

export default function prMonitorApiFixture() {
	const original = globalThis.fetch
	globalThis.fetch = async (input, options) => {
		const url = new URL(input instanceof Request ? input.url : String(input))
		if (url.hostname !== "api.github.com") return original(input, options)
		const headers = new Headers(options?.headers)
		if (headers.get("authorization") !== "Bearer pr-monitor-fixture-token")
			throw new Error("Unexpected fixture credential")
		const data = JSON.parse(readFileSync(process.env.KIMCHI_TEST_PR_MONITOR, "utf8"))
		const requestedNumber =
			url.pathname === "/graphql"
				? JSON.parse(options.body).variables.number
				: Number(/\/pulls\/(\d+)/.exec(url.pathname)?.[1])
		const commit = /\/commits\/([a-f\d]+)/.exec(url.pathname)?.[1]
		const seed = data.targets
			? data.targets.find((target) =>
					requestedNumber
						? target.number === requestedNumber
						: commit
							? execFileSync("git", ["--git-dir", target.bare, "rev-parse", target.branch], {
									encoding: "utf8",
								}).trim() === commit
							: true,
				)
			: data
		if (!seed) throw new Error(`Unexpected PR target ${url.pathname}`)
		const branch = seed.branch ?? "feature"
		const head = execFileSync("git", ["--git-dir", seed.bare, "rev-parse", `refs/heads/${branch}`], {
			encoding: "utf8",
		}).trim()
		const initial = head === seed.head
		const number = seed.number ?? 7
		const base = "/repos/example/kimchi-lab"
		if (url.pathname === base)
			return Response.json({
				id: 42,
				full_name: "example/kimchi-lab",
				html_url: "https://github.com/example/kimchi-lab",
				default_branch: "main",
			})
		if (url.pathname === `${base}/pulls/${number}`)
			return Response.json({
				number,
				title: "Fix parser",
				html_url: `https://github.com/example/kimchi-lab/pull/${number}`,
				state: "open",
				head: { sha: head, ref: branch, repo: { clone_url: "https://github.com/example/kimchi-lab.git" } },
				merge_commit_sha: null,
				merged_at: null,
				closed_at: null,
			})
		if (url.pathname === `${base}/pulls` || /\/commits\/[a-f\d]+\/pulls$/.test(url.pathname))
			return Response.json(
				seed.exists === false
					? []
					: [
							{
								id: number,
								number,
								title: "Fix parser",
								html_url: `https://github.com/example/kimchi-lab/pull/${number}`,
								state: "open",
								head: { sha: head, ref: branch },
								merge_commit_sha: null,
								merged_at: null,
								closed_at: null,
							},
						],
			)
		if (url.pathname.endsWith("/check-runs"))
			return Response.json({
				total_count: 1,
				check_runs: [
					{
						id: 1,
						name: "Parser tests",
						status: "completed",
						conclusion: initial && seed.kind === "ci" ? "failure" : "success",
						completed_at: head,
						details_url: "https://github.com/example/kimchi-lab/actions/runs/1",
						output: { summary: "answer.txt must contain fixed" },
					},
				],
			})
		if (url.pathname.endsWith("/status")) return Response.json({ total_count: 0, statuses: [] })
		if (url.pathname.endsWith("/comments")) return Response.json([])
		if (url.pathname === "/graphql") {
			if (options?.method !== "POST") throw new Error("Review query must use POST")
			const body = JSON.parse(options.body)
			if (body.variables.owner !== "example" || body.variables.name !== "kimchi-lab")
				throw new Error("Unexpected review repository")
			return Response.json({
				data: {
					repository: {
						pullRequest: {
							headRefOid: head,
							reviewThreads: {
								pageInfo: { hasNextPage: false },
								nodes:
									initial && seed.kind === "review"
										? [
												{
													id: "thread-1",
													isResolved: false,
													isOutdated: false,
													comments: {
														nodes: [
															{
																id: "comment-1",
																databaseId: 1,
																body: "Change answer.txt to fixed and cover the empty parser result.",
																url: "https://github.com/example/kimchi-lab/pull/7#discussion_r1",
																updatedAt: "2026-11-12T12:00:00Z",
																path: "answer.txt",
																line: 1,
																author: { login: "reviewer" },
																authorAssociation: "MEMBER",
															},
														],
													},
												},
											]
										: [],
							},
						},
					},
				},
			})
		}
		throw new Error(`Unexpected fixture URL ${url.pathname}`)
	}
}
