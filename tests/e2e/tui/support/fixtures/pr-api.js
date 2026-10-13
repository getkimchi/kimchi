import { appendFileSync, readFileSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"

// Isolated test extension: only the two fixture repositories are intercepted.
// Model and fixture-server traffic uses the original fetch unchanged.
export default function prApiFixture() {
	const originalFetch = globalThis.fetch
	globalThis.fetch = async (input, options) => {
		const url = new URL(input instanceof Request ? input.url : String(input))
		if (url.hostname !== "api.github.com" && url.hostname !== "gitlab.com") return originalFetch(input, options)
		const provider = process.env.KIMCHI_TEST_PR_PROVIDER
		const host = provider === "gitlab" ? "gitlab.com" : "api.github.com"
		const project = provider === "gitlab" ? "example/group/kimchi-lab" : "example/kimchi-lab"
		const base = provider === "gitlab" ? `/api/v4/projects/${encodeURIComponent(project)}` : `/repos/${project}`
		let state = JSON.parse(readFileSync(process.env.KIMCHI_TEST_PR_STATE, "utf8"))
		const commits =
			provider === "gitlab"
				? `${base}/repository/commits/${state.headSha}/merge_requests`
				: `${base}/commits/${state.headSha}/pulls`
		const kind = url.pathname === base ? "repository" : url.pathname === commits ? "commit" : undefined
		const headers = new Headers(options?.headers ?? (input instanceof Request ? input.headers : undefined))
		const tokenMatched = headers.get("authorization") === `Bearer ${process.env.KIMCHI_TEST_PR_TOKEN}`
		if (
			url.protocol !== "https:" ||
			url.host !== host ||
			!kind ||
			!tokenMatched ||
			(options?.method ?? (input instanceof Request ? input.method : "GET")) !== "GET" ||
			(kind === "repository" ? url.search !== "" : url.search !== "?per_page=100")
		) {
			throw new Error("Unexpected fixture API request or credential")
		}
		if (kind === "commit") {
			const deadline = Date.now() + 8000
			while (state.mode === "hold" && Date.now() < deadline) {
				await delay(25, undefined, { signal: options?.signal ?? (input instanceof Request ? input.signal : undefined) })
				state = JSON.parse(readFileSync(process.env.KIMCHI_TEST_PR_STATE, "utf8"))
			}
		}
		appendFileSync(
			process.env.KIMCHI_TEST_PR_CALLS,
			`${JSON.stringify({ kind, mode: state.mode, tokenMatched, path: url.pathname })}\n`,
		)
		if (kind === "repository")
			return Response.json(
				provider === "gitlab"
					? { id: 42, path_with_namespace: project, web_url: `https://gitlab.com/${project}` }
					: { full_name: project, html_url: `https://github.com/${project}` },
			)
		if (state.mode === "auth") return Response.json({ message: "Fixture authentication failure" }, { status: 401 })
		if (state.mode !== "open" && state.mode !== "merged") throw new Error("The test did not release the API lookup")
		const mergedAt = state.mode === "merged" ? (state.mergedAt ?? new Date().toISOString()) : null
		const mergeCommitSha = mergedAt ? "f".repeat(40) : null
		return Response.json(
			provider === "gitlab"
				? [
						{
							id: 98731,
							iid: 731,
							source_project_id: 42,
							web_url: `https://gitlab.com/${project}/-/merge_requests/731`,
							state: mergedAt ? "merged" : "opened",
							sha: state.headSha,
							merge_commit_sha: mergeCommitSha,
							merged_at: mergedAt,
							closed_at: null,
						},
					]
				: [
						{
							number: 731,
							html_url: `https://github.com/${project}/pull/731`,
							state: mergedAt ? "closed" : "open",
							head: { sha: state.headSha },
							merge_commit_sha: mergeCommitSha,
							merged_at: mergedAt,
							closed_at: mergedAt,
						},
					],
		)
	}
}
