/** The checked-out branch and its PR or MR, independent of recorded-work associations. */

import { object } from "../work-attribution/summary.js"
import { api, command, pages, repositoryIdentity, requestJSON } from "./provider-api.js"
import { LookupError, label, pullRequest } from "./provider-records.js"
import { PASS_BUDGET_MS, type WorkPullRequest } from "./pull-requests.js"

export interface BranchPullRequest {
	branch: string
	pullRequest?: WorkPullRequest
}

export async function currentBranch(cwd: string, signal: AbortSignal, deadline: number): Promise<string | undefined> {
	return command(
		"git",
		["-C", cwd, "symbolic-ref", "--quiet", "--short", "HEAD"],
		cwd,
		signal,
		Math.min(deadline, Date.now() + 2000),
	)
}

/** A branch status check has no work identity, ledger, summary, or attribution side effects. */
export async function lookupBranchPullRequest(
	cwd: string,
	signal: AbortSignal,
): Promise<BranchPullRequest | undefined> {
	const deadline = Date.now() + PASS_BUDGET_MS
	const branch = await currentBranch(cwd, signal, deadline)
	if (!branch) return undefined
	let pull: WorkPullRequest | undefined
	let failure: unknown
	try {
		const remote = await repositoryIdentity(cwd, signal, deadline, new Map(), branch)
		// Default branches are shared, so a branch-name match cannot identify the current work.
		if (remote.defaultBranch && remote.defaultBranch !== branch) {
			const url = api(remote, remote.provider === "github" ? "pulls" : "merge_requests")
			url.search = new URLSearchParams(
				remote.provider === "github"
					? {
							state: "all",
							head: `${remote.name.split("/")[0]}:${branch}`,
							sort: "updated",
							direction: "desc",
							per_page: "100",
						}
					: {
							scope: "all",
							state: "all",
							source_branch: branch,
							// Forks often reuse branch names such as main; older GitLab ignores this filter, so results are checked below.
							source_project_id: String(remote.id),
							order_by: "updated_at",
							sort: "desc",
							per_page: "100",
						},
			).toString()
			const values =
				remote.provider === "gitlab"
					? await pages(remote, url, signal, deadline)
					: (await requestJSON(remote, url, signal, deadline)).value
			if (!Array.isArray(values)) throw new LookupError(`${label(remote)} returned invalid pull requests.`)
			const checkedAt = new Date().toISOString()
			const pulls = (
				remote.provider === "gitlab"
					? values.filter(
							(value) => object(value) && value.source_project_id === remote.id && value.source_branch === branch,
						)
					: values
			).map((value) => {
				const head = object(value)
					? remote.provider === "gitlab"
						? value.source_branch
						: object(value.head)
							? value.head.ref
							: undefined
					: undefined
				if (head !== branch) throw new LookupError(`${label(remote)} returned a pull request for a different branch.`)
				return pullRequest(value, remote, checkedAt)
			})
			pull = pulls.find((item) => item.state === "open")
			if (!pull && pulls.length) {
				// A closed or merged PR can belong to an earlier branch with the same name; show it only when this
				// branch once pointed at its head commit.
				const history = await command(
					"git",
					["-C", cwd, "reflog", "show", "-n", "1000", "--format=%H", `refs/heads/${branch}`, "--"],
					cwd,
					signal,
					deadline,
				)
				const held = new Set(history?.split("\n"))
				pull = pulls.find((item) => held.has(item.headSha))
			}
		}
	} catch (error) {
		failure = error
	}
	// Ignore a result for a branch that was checked out while the provider was responding.
	if ((await currentBranch(cwd, signal, Date.now() + 2000)) !== branch) return undefined
	if (failure) throw failure
	return { branch, pullRequest: pull }
}
