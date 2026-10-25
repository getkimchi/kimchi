import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { BASH_BACKGROUND_EXIT_MESSAGE_TYPE } from "../bash-background/bash-control-extension.js"
import { detectSuggestions, pullRequestUrls } from "./detect.js"

const PR = "https://github.com/acme/app/pull/1531"
const OTHER_PR = "https://github.com/acme/app/pull/1532"
const MR = "https://gitlab.com/acme/group/app/-/merge_requests/42"

let nextId = 0

function entry(message: Extract<SessionEntry, { type: "message" }>["message"]): SessionEntry {
	nextId++
	return { type: "message", id: `e${nextId}`, parentId: null, timestamp: "2026-10-25T00:00:00.000Z", message }
}

function user(text: string): SessionEntry {
	return entry({ role: "user", content: text, timestamp: 0 })
}

function reply(text: string): SessionEntry {
	return entry({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "kimchi",
		model: "fake",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	})
}

/** An assistant tool call and its result. */
function tool(name: string, args: Record<string, string | boolean>, output: string, details?: object, isError = false) {
	const id = `call-${++nextId}`
	return [
		entry({
			role: "assistant",
			content: [{ type: "toolCall", id, name, arguments: args }],
			api: "openai-completions",
			provider: "kimchi",
			model: "fake",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 0,
		}),
		entry({
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text: output }],
			...(details ? { details: { ...details } } : {}),
			isError,
			timestamp: 0,
		}),
	]
}

function bash(command: string, output: string, isError = false): SessionEntry[] {
	return tool("bash", { command }, output, undefined, isError)
}

/** A bash call still running after its handoff: its result carries only the first output. */
function backgroundBash(command: string, firstOutput: string, handle: string): SessionEntry[] {
	return tool("bash", { command }, `[Background bash process\n handle: ${handle}\n]\n${firstOutput}`, {
		handle,
		exited: false,
		handoff: true,
	})
}

/** The harness's unattended exit notification for background commands. */
function exitNotice(handles: string[], output: string): SessionEntry {
	nextId++
	return {
		type: "custom_message",
		id: `e${nextId}`,
		parentId: null,
		timestamp: "2026-10-25T00:00:00.000Z",
		customType: BASH_BACKGROUND_EXIT_MESSAGE_TYPE,
		content: [{ type: "text", text: output }],
		details: { deliveryId: "d1", sessionId: "s1", handles },
		display: false,
	}
}

const PUSHED = "To github.com:acme/app.git\n   509290d8..d8b310bc  feat-x -> feat-x\n"

const none = new Set<string>()

describe("detectSuggestions", () => {
	it("suggests watching the PR that gh pr create printed", () => {
		const entries = [user("open a PR"), ...bash("gh pr create --fill", `Creating pull request\n${PR}\n`), reply(PR)]

		expect(detectSuggestions({ entries, dismissed: none, watching: none })).toEqual([
			{ key: PR, label: "PR #1531", skill: "watch-pr", args: PR, watching: false },
		])
	})

	it("suggests watching the MR that glab mr create printed", () => {
		const entries = bash("glab mr create --fill --yes", `!42 feat: things (feat)\n ${MR}\n`)

		expect(detectSuggestions({ entries, dismissed: none, watching: none })).toEqual([
			{ key: MR, label: "MR !42", skill: "watch-pr", args: MR, watching: false },
		])
	})

	it("ignores a PR URL that was only pasted or mentioned", () => {
		const entries = [user(`please look at ${PR}`), ...bash("gh pr view 1531", `${PR}\nopen`), reply(`See ${PR}`)]

		expect(detectSuggestions({ entries, dismissed: none, watching: none })).toEqual([])
	})

	it("ignores a publish command that failed", () => {
		const entries = bash("gh pr create --fill", `a pull request already exists: ${PR}`, true)

		expect(detectSuggestions({ entries, dismissed: none, watching: none })).toEqual([])
	})

	it("suggests the branch's open PR once this session pushed that branch", () => {
		const entries = bash("git push", "To github.com:acme/app.git\n   1a2b3c4..5d6e7f8  feat-x -> feat-x\n")
		const branch = { name: "feat-x", pullRequest: { url: PR, state: "open" as const } }

		expect(detectSuggestions({ entries, branch, dismissed: none, watching: none }).map((s) => s.key)).toEqual([PR])
	})

	it("ignores the branch's open PR when this session did not push it", () => {
		const branch = { name: "feat-x", pullRequest: { url: PR, state: "open" as const } }
		const pushedElsewhere = bash("git push", "To github.com:acme/app.git\n   1a2b3c4..5d6e7f8  other -> other\n")

		expect(detectSuggestions({ entries: [], branch, dismissed: none, watching: none })).toEqual([])
		expect(detectSuggestions({ entries: pushedElsewhere, branch, dismissed: none, watching: none })).toEqual([])
	})

	it.each(["merged", "closed"] as const)("hides a %s PR", (state) => {
		const entries = bash("gh pr create --fill", PR)
		const branch = { name: "feat-x", pullRequest: { url: PR, state } }

		expect(detectSuggestions({ entries, branch, dismissed: none, watching: none })).toEqual([])
	})

	it("hides a dismissed PR", () => {
		const entries = bash("gh pr create --fill", PR)

		expect(detectSuggestions({ entries, dismissed: new Set([PR]), watching: none })).toEqual([])
	})

	it("marks a PR whose watch is running", () => {
		const entries = bash("gh pr create --fill", PR)

		expect(detectSuggestions({ entries, dismissed: none, watching: new Set([PR]) })).toEqual([
			{ key: PR, label: "PR #1531", skill: "watch-pr", args: PR, watching: true },
		])
	})

	it("follows a backgrounded git push to its output in a bash_control result", () => {
		// The pre-push hook outlasts the handoff, so the push summary arrives with the exit.
		const entries = [
			...backgroundBash("git commit -m docs && git push", "[feat-x d8b310bc] docs\n> lint", "h-1"),
			...tool("bash_control", { wait: true }, `Final output:\nFound 2 warnings.\n${PUSHED}`, {
				exitedHandles: ["h-1"],
				runningHandles: [],
			}),
		]
		const branch = { name: "feat-x", pullRequest: { url: PR, state: "open" as const } }

		expect(detectSuggestions({ entries, branch, dismissed: none, watching: none }).map((s) => s.key)).toEqual([PR])
	})

	it("follows a backgrounded git push to its output in an exit notification", () => {
		const entries = [...backgroundBash("git push", "> lint", "h-1"), exitNotice(["h-1"], PUSHED)]
		const branch = { name: "feat-x", pullRequest: { url: PR, state: "open" as const } }

		expect(detectSuggestions({ entries, branch, dismissed: none, watching: none }).map((s) => s.key)).toEqual([PR])
	})

	it("ignores another command's background output", () => {
		const entries = [
			...backgroundBash("git push", "> lint", "h-1"),
			...tool("bash_control", { wait: true }, PUSHED, { exitedHandles: ["h-2"] }),
		]
		const branch = { name: "feat-x", pullRequest: { url: PR, state: "open" as const } }

		expect(detectSuggestions({ entries, branch, dismissed: none, watching: none })).toEqual([])
	})

	it("ignores a rejected push", () => {
		const entries = bash(
			"git push",
			"To github.com:acme/app.git\n ! [rejected]        feat-x -> feat-x (fetch first)\n",
		)
		const branch = { name: "feat-x", pullRequest: { url: PR, state: "open" as const } }

		expect(detectSuggestions({ entries, branch, dismissed: none, watching: none })).toEqual([])
	})

	it("shows one chip per PR", () => {
		const entries = [
			...bash("gh pr create --fill", PR),
			...bash("gh pr create --fill --head other", OTHER_PR),
			...bash("git push", `remote: ${PR}\n   1a2b3c4..5d6e7f8  feat-x -> feat-x`),
		]
		const branch = { name: "feat-x", pullRequest: { url: PR, state: "open" as const } }

		expect(detectSuggestions({ entries, branch, dismissed: none, watching: none }).map((s) => s.key)).toEqual([
			PR,
			OTHER_PR,
		])
	})
})

describe("pullRequestUrls", () => {
	it("finds GitHub PR and GitLab MR URLs in order", () => {
		expect(pullRequestUrls(`first ${MR}. then ${PR}/files and ${PR}`)).toEqual([MR, PR])
	})

	it("skips push hints for PRs and MRs that do not exist yet", () => {
		const output = [
			"remote: Create a pull request for 'feat-x' on GitHub by visiting:",
			"remote:      https://github.com/acme/app/pull/new/feat-x",
			"remote:   https://gitlab.com/acme/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat-x",
		].join("\n")

		expect(pullRequestUrls(output)).toEqual([])
	})
})
