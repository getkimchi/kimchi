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
							per_page: "30",
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
			let invalid: unknown
			const pulls = (
				remote.provider === "gitlab"
					? values.filter(
							(value) => object(value) && value.source_project_id === remote.id && value.source_branch === branch,
						)
					: values
			).flatMap((value) => {
				const head = object(value)
					? remote.provider === "gitlab"
						? value.source_branch
						: object(value.head)
							? value.head.ref
							: undefined
					: undefined
				if (head !== branch) throw new LookupError(`${label(remote)} returned a pull request for a different branch.`)
				try {
					return [pullRequest(value, remote, checkedAt)]
				} catch (error) {
					// One malformed old record must not hide a valid PR; it fails the lookup only when nothing is shown.
					invalid ??= error
					return []
				}
			})
			pull = pulls.find((item) => item.state === "open")
			if (!pull && pulls.length) {
				// A branch name can be reused after its PR closes, even from that PR's head after a fast-forward merge.
				// Show a closed or merged PR only if it closed after this local branch was created: the oldest reflog entry.
				const history = await command(
					"git",
					["-C", cwd, "reflog", "show", "--date=unix", "--format=%gd", `refs/heads/${branch}`, "--"],
					cwd,
					signal,
					Date.now() + 2000,
				)
				const created = Number(/@\{(\d+)\}$/.exec(history?.split("\n").at(-1) ?? "")?.[1]) * 1000
				pull = pulls.find((item) => Date.parse(item.closedAt ?? item.mergedAt ?? "") >= created)
			}
			if (!pull && invalid) throw invalid
		}
	} catch (error) {
		failure = error
	}
	// Ignore a result for a branch that was checked out while the provider was responding.
	if ((await currentBranch(cwd, signal, Date.now() + 2000)) !== branch) return undefined
	if (failure) throw failure
	return { branch, pullRequest: pull }
}
