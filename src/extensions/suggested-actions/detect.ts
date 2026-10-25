/**
 * Which follow-up actions fit what this session just did. Deterministic and
 * side-effect free: the caller supplies the session entries, the current
 * branch's PR (from `lookupBranchPullRequest`), and the chip state.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { BASH_BACKGROUND_EXIT_MESSAGE_TYPE } from "../bash-background/bash-control-extension.js"
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
	/** Everything the command printed, including output delivered after it moved to the background. */
	output: string
}

function text(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content
	return content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n")
}

/** String items of `details[key]`, for the background-command handles a result or notification names. */
function handles(details: unknown, ...keys: string[]): string[] {
	if (!details || typeof details !== "object") return []
	return keys.flatMap((key) => {
		const value: unknown = Reflect.get(details, key)
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
	})
}

/**
 * Successful `git push` / `gh pr create` / `glab mr create` bash calls this session made, oldest first. A bash call
 * still running after its handoff returns only its first output; the rest (e.g. the push summary after a slow
 * pre-push hook) arrives later, keyed by the command's handle, in a `bash_control` result or an exit notification.
 */
export function publishEvidence(entries: readonly SessionEntry[]): PublishEvidence[] {
	const commands = new Map<string, string>()
	const evidence: PublishEvidence[] = []
	const backgrounded = new Map<string, PublishEvidence>()
	const deliver = (ids: string[], output: string) => {
		for (const id of new Set(ids)) {
			const item = backgrounded.get(id)
			if (item) item.output += `\n${output}`
		}
	}
	for (const entry of entries) {
		if (entry.type === "custom_message" && entry.customType === BASH_BACKGROUND_EXIT_MESSAGE_TYPE) {
			deliver(handles(entry.details, "handles"), text(entry.content))
			continue
		}
		if (entry.type !== "message") continue
		const { message } = entry
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type !== "toolCall" || part.name !== "bash") continue
				const { command } = part.arguments
				if (typeof command === "string" && PUBLISH_COMMAND.test(command)) commands.set(part.id, command)
			}
		} else if (message.role === "toolResult" && message.toolName === "bash_control") {
			deliver(handles(message.details, "exitedHandles", "runningHandles"), text(message.content))
		} else if (message.role === "toolResult" && !message.isError) {
			const command = commands.get(message.toolCallId)
			if (command === undefined) continue
			const item = { command, output: text(message.content) }
			evidence.push(item)
			// A command still running after the handoff names the handle its later output arrives under.
			const handle = message.details && typeof message.details === "object" && Reflect.get(message.details, "handle")
			if (typeof handle === "string") backgrounded.set(handle, item)
		}
	}
	return evidence
}

/** A `git push` summary line that updated `branch` on the remote; rejected (`!`) lines do not count. */
function pushedBranch(output: string, branch: string): boolean {
	const name = branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	return new RegExp(
		String.raw`^\s*(?:\+\s*)?(?:[0-9a-f]+\.\.\.?[0-9a-f]+|\* \[new branch\])\s+\S+\s+->\s+${name}(?:\s|$)`,
		"m",
	).test(output)
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
		branch &&
		branchPr?.state === "open" &&
		evidence.some(({ command, output }) => /\bgit\s+push\b/.test(command) && pushedBranch(output, branch.name))
	)
		urls.push(branchPr.url)
	const closed = branchPr && branchPr.state !== "open" ? branchPr.url : undefined
	return [...new Set(urls)]
		.filter((url) => url !== closed && !dismissed.has(url))
		.map((url) => ({ key: url, label: label(url), skill: WATCH_PR_SKILL, args: url, watching: watching.has(url) }))
}
