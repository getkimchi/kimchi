import { execFileSync } from "node:child_process"
import { parseState, type State } from "./state.ts"

export const LABEL = "pi-upgrade"

/** The latest `pi-upgrade` issue (open or closed) and the bot comment holding its state. */
export interface IssueSnapshot {
	number: number
	state: "open" | "closed"
	title: string
	stateCommentId?: number
	stateCommentBody?: string
}

export function gh(args: string[], input?: string): string {
	return execFileSync("gh", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] })
}

/**
 * `gh api --paginate --jq` applies the filter per page, so a single JSON array would be one array per
 * page; emitting one JSON string per comment and parsing line by line works across pages.
 */
export function parseCommentLines(stdout: string): Array<{ id: number; body: string }> {
	return stdout
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line))
}

export function findIssue(): IssueSnapshot | null {
	const issues = JSON.parse(
		gh(["issue", "list", "--label", LABEL, "--state", "all", "--limit", "1", "--json", "number,state,title"]),
	) as Array<{ number: number; state: string; title: string }>
	const issue = issues[0]
	if (!issue) return null
	const comments = parseCommentLines(
		gh([
			"api",
			"--paginate",
			`repos/{owner}/{repo}/issues/${issue.number}/comments`,
			"--jq",
			".[] | {id, body} | @json",
		]),
	)
	const stateComment = comments.find((c) => c.body.includes("<!-- pi-upgrade-state"))
	return {
		number: issue.number,
		state: issue.state.toLowerCase() === "open" ? "open" : "closed",
		title: issue.title,
		stateCommentId: stateComment?.id,
		stateCommentBody: stateComment?.body,
	}
}

/** State from a local file (`--state`) or, read-only, from the live issue; empty when neither exists. */
export function loadState(stateFile: string | undefined, readFile: (path: string) => string): State {
	if (stateFile) return parseState(readFile(stateFile))
	try {
		return parseState(findIssue()?.stateCommentBody)
	} catch {
		// No gh / no auth / no repo: a local run starts from scratch.
		return parseState(undefined)
	}
}
