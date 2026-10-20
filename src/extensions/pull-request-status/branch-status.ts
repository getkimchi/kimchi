/** The checked-out branch and its PR or MR, shown in the footer. */

import { api, command, pages, repositoryIdentity, requestJSON } from "./provider-api.js"
import { isRecord, LookupError, label, type PullRequestLink, pullRequest } from "./provider-records.js"

/** One branch lookup, including repository identity, gets at most this long. */
const LOOKUP_BUDGET_MS = 10_000

export interface BranchPullRequest {
	branch: string
	pullRequest?: PullRequestLink
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

/** A read-only lookup of the checked-out branch's PR or MR; it records nothing. */
export async function lookupBranchPullRequest(
	cwd: string,
	signal: AbortSignal,
): Promise<BranchPullRequest | undefined> {
	const deadline = Date.now() + LOOKUP_BUDGET_MS
	const branch = await currentBranch(cwd, signal, deadline)
	if (!branch) return undefined
	let pull: PullRequestLink | undefined
	let failure: unknown
	try {
		const remote = await repositoryIdentity(cwd, signal, deadline, new Map(), branch)
		const url = api(remote, remote.provider === "github" ? "pulls" : "merge_requests")
		url.search = new URLSearchParams(
			remote.provider === "github"
				? {
						state: "all",
						head: `${remote.name.split("/")[0]}:${branch}`,
						sort: "updated",
						direction: "desc",
						per_page: "1",
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
		const value =
			remote.provider === "gitlab"
				? values.find(
						(value) => isRecord(value) && value.source_project_id === remote.id && value.source_branch === branch,
					)
				: values[0]
		if (value !== undefined) {
			const head = isRecord(value)
				? remote.provider === "gitlab"
					? value.source_branch
					: isRecord(value.head)
						? value.head.ref
						: undefined
				: undefined
			if (head !== branch) throw new LookupError(`${label(remote)} returned a pull request for a different branch.`)
			pull = pullRequest(value, remote)
		}
	} catch (error) {
		failure = error
	}
	// Ignore a result for a branch that was checked out while the provider was responding.
	if ((await currentBranch(cwd, signal, Date.now() + 2000)) !== branch) return undefined
	if (failure) throw failure
	return { branch, pullRequest: pull }
}
