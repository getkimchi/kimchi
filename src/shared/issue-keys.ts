/** An uppercase project key of at least two characters, a dash and an issue number, within the lengths the backend accepts in titles. */
export const ISSUE_KEY = /^[A-Z][A-Z0-9_]{1,254}-[1-9][0-9]{0,15}$/
/** Key-shaped tokens; a letter, digit or underscore on either side makes one part of a longer word. */
const BRANCH_ISSUE_KEYS = /(?<![A-Za-z0-9_])[A-Z][A-Z0-9_]{1,254}-[1-9][0-9]{0,15}(?![A-Za-z0-9_])/g
/** The most Jira keys a PR cost upload carries for one PR, as the backend bounds them. */
export const MAX_PULL_REQUEST_ISSUE_KEYS = 20

/** The distinct Jira-key-shaped tokens of a branch name, in order. */
export function branchIssueKeys(branch: string): string[] {
	return [...new Set(branch.match(BRANCH_ISSUE_KEYS))]
}
