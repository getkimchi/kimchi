/**
 * Which follow-up actions fit what this session just did. Deterministic and
 * side-effect free: the caller supplies the session entries, the current
 * branch's PR (from `lookupBranchPullRequest`), and the chip state.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { PUBLISH_COMMAND } from "../pull-request-status/links.js"
import type { WorkPullRequest } from "../pull-request-status/pull-requests.js"

export const WATCH_PR_SKILL = "watch-pr"

export interface Suggestion {
	/** The PR/MR URL; one chip per PR. */
	key: string
	/** `PR #7` or `MR !7`. */
	label: string
	skill: string
	args: string
	/** A watch run for this PR has been requested and has not finished yet. */
	watching: boolean
}

export interface DetectInput {
	entries: readonly SessionEntry[]
	/** The checked-out branch and its PR, when looked up. */
	branch?: { name: string; pullRequest?: Pick<WorkPullRequest, "url" | "state"> }
	dismissed: ReadonlySet<string>
	watching: ReadonlySet<string>
}

const GITHUB_PR = /https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+(?!\w)/g
const GITLAB_MR = /https:\/\/[^\s/]+\/(?:[^\s/]+\/)+-\/merge_requests\/\d+(?!\w)/g

/** PR/MR URLs in `text`, in order of appearance. `…/pull/new/branch` push hints are not PRs. */
export function pullRequestUrls(text: string): string[] {
	const found = [...text.matchAll(GITHUB_PR), ...text.matchAll(GITLAB_MR)].sort((a, b) => a.index - b.index)
	return [...new Set(found.map((match) => match[0]))]
}

function label(url: string): string {
	const number = /(\d+)$/.exec(url)?.[1]
	return url.includes("/-/merge_requests/") ? `MR !${number}` : `PR #${number}`
}

interface PublishEvidence {
	command: string
	output: string
}

/** Successful `git push` / `gh pr create` / `glab mr create` bash calls this session made, oldest first. */
export function publishEvidence(entries: readonly SessionEntry[]): PublishEvidence[] {
	const commands = new Map<string, string>()
	const evidence: PublishEvidence[] = []
	for (const entry of entries) {
		if (entry.type !== "message") continue
		const { message } = entry
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type !== "toolCall" || part.name !== "bash") continue
				const { command } = part.arguments
				if (typeof command === "string" && PUBLISH_COMMAND.test(command)) commands.set(part.id, command)
			}
		} else if (message.role === "toolResult" && !message.isError) {
			const command = commands.get(message.toolCallId)
			if (command === undefined) continue
			const output = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
			evidence.push({ command, output })
		}
	}
	return evidence
}

/**
 * A PR counts as this session's when a publish command printed its URL, or when the checked-out branch has an open
 * PR and this session pushed that branch. A URL the user pasted, or the model merely mentioned, never counts.
 */
export function detectSuggestions(input: DetectInput): Suggestion[] {
	const { branch, dismissed, watching } = input
	const evidence = publishEvidence(input.entries)
	const urls = evidence.flatMap(({ output }) => pullRequestUrls(output))
	const branchPr = branch?.pullRequest
	if (
		branchPr?.state === "open" &&
		evidence.some(({ command, output }) => /\bgit\s+push\b/.test(command) && output.includes(`-> ${branch?.name}`))
	)
		urls.push(branchPr.url)
	const closed = branchPr && branchPr.state !== "open" ? branchPr.url : undefined
	return [...new Set(urls)]
		.filter((url) => url !== closed && !dismissed.has(url))
		.map((url) => ({ key: url, label: label(url), skill: WATCH_PR_SKILL, args: url, watching: watching.has(url) }))
}
