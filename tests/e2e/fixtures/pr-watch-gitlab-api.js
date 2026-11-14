import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

export default function mrMonitorApiFixture() {
	const original = globalThis.fetch
	globalThis.fetch = async (input, options) => {
		const url = new URL(input instanceof Request ? input.url : String(input))
		if (url.hostname !== "gitlab.fixture.test") return original(input, options)
		if (new Headers(options?.headers).get("authorization") !== "Bearer pr-watch-fixture-token")
			throw new Error("Unexpected GitLab fixture credential")
		const data = JSON.parse(readFileSync(process.env.KIMCHI_TEST_PR_WATCH, "utf8"))
		const number = Number(/\/(?:merge_requests|pipelines)\/(\d+)/.exec(url.pathname)?.[1])
		const seed = data.targets.find((target) => !number || target.number === number)
		if (!seed) throw new Error(`Unexpected MR target ${url.pathname}`)
		const head = execFileSync("git", ["--git-dir", seed.bare, "rev-parse", seed.branch], { encoding: "utf8" }).trim()
		const initial = head === seed.head
		const prURL = `https://gitlab.fixture.test/group/subgroup/kimchi-lab/-/merge_requests/${seed.number}`
		if (url.pathname === "/api/v4/projects/42")
			return Response.json({ http_url_to_repo: "https://gitlab.fixture.test/group/subgroup/kimchi-lab.git" })
		if (url.pathname.endsWith(`/merge_requests/${seed.number}`))
			return Response.json({
				iid: seed.number,
				state: "opened",
				title: "Fix parser",
				web_url: prURL,
				sha: head,
				source_branch: seed.branch,
				source_project_id: 42,
				target_project_id: 42,
				merge_commit_sha: null,
				merged_at: null,
				closed_at: null,
				head_pipeline: {
					id: seed.number,
					status: initial && seed.kind === "ci" ? "failed" : "success",
					updated_at: head,
					web_url: prURL,
				},
			})
		if (url.pathname.endsWith("/jobs"))
			return Response.json([
				{
					id: seed.number,
					name: "Parser tests",
					status: initial && seed.kind === "ci" ? "failed" : "success",
					web_url: `${prURL}#jobs`,
					finished_at: head,
					failure_reason: "answer.txt must contain fixed",
				},
			])
		if (url.pathname.endsWith("/discussions"))
			return Response.json(
				initial && seed.kind === "review"
					? [
							{
								id: `thread-${seed.number}`,
								notes: [
									{
										id: seed.number,
										body: "Add a parser regression test",
										resolvable: true,
										resolved: false,
										author: { id: 6, username: "member" },
										updated_at: head,
										position: { new_path: "answer.txt", new_line: 1 },
									},
								],
							},
						]
					: [],
			)
		if (url.pathname.endsWith("/members/all/6")) return Response.json({ access_level: 30 })
		throw new Error(`Unexpected GitLab fixture URL ${url.pathname}`)
	}
}
