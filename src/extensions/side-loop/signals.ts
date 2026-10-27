/**
 * Detectors: a finished tool call in, zero or more side-loop signals out.
 * Pure apart from the artifact detector's existence/mtime checks.
 */
import { artifactsFromToolCall } from "../artifacts/detect.js"

export interface PullRequestRef {
	host: "github" | "gitlab"
	url: string
	repo: string
	number: number
}

export type Signal =
	| { kind: "pr"; pr: PullRequestRef; created: boolean }
	| { kind: "artifact"; path: string; name: string; origin: "declared" | "write" | "sniffed" }
	| { kind: "tests"; command: string; passed: number; failed: number; ok: boolean }
	| { kind: "deploy"; command: string; target: string; url?: string; ok: boolean }
	| { kind: "message"; service: string; channel: string; text: string; direction: "sent" | "received" }

const CREATE_COMMAND = /\b(?:gh\s+pr\s+create|glab\s+mr\s+create)\b/
const GITHUB_PR = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/
const GITLAB_MR = /https:\/\/[\w.-]+\/([\w./-]+?)\/-\/merge_requests\/(\d+)/

export function resultText(result: unknown): string {
	const content = (result as { content?: unknown } | null | undefined)?.content
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
		.join("\n")
}

export function parsePullRequestUrl(text: string): PullRequestRef | undefined {
	const github = GITHUB_PR.exec(text)
	if (github) return { host: "github", url: github[0], repo: github[1], number: Number(github[2]) }
	const gitlab = GITLAB_MR.exec(text)
	if (gitlab) return { host: "gitlab", url: gitlab[0], repo: gitlab[1], number: Number(gitlab[2]) }
	return undefined
}

/** A PR exists once a create command printed its URL; reading a PR elsewhere doesn't create a card. */
export function pullRequestSignal(toolName: string, args: unknown, result: unknown, isError: boolean): Signal[] {
	if (isError || (toolName !== "bash" && toolName !== "powershell")) return []
	const command = (args as { command?: unknown } | null | undefined)?.command
	if (typeof command !== "string" || !CREATE_COMMAND.test(command)) return []
	const pr = parsePullRequestUrl(resultText(result))
	return pr ? [{ kind: "pr", pr, created: true }] : []
}

const TEST_COMMAND = /\b(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test|vitest|jest|pytest|go\s+test|cargo\s+test)\b/
const DEPLOY_COMMAND =
	/\b(kubectl\s+(?:apply|rollout\s+status)|helm\s+(?:upgrade|install)|vercel(?:\s+deploy)?|fly\s+deploy|netlify\s+deploy|gcloud\s+run\s+deploy)\b/

function count(text: string, word: "passed" | "failed"): number {
	// vitest "Tests  2 failed | 40 passed", jest "1 failed, 12 passed", pytest "2 failed, 10 passed in"
	const matches = [...text.matchAll(new RegExp(`(\\d+)\\s+${word}`, "g"))]
	const last = matches.at(-1)
	return last ? Number(last[1]) : 0
}

export function testSignal(toolName: string, args: unknown, result: unknown, isError: boolean): Signal[] {
	if (toolName !== "bash" && toolName !== "powershell") return []
	const command = (args as { command?: unknown } | null | undefined)?.command
	if (typeof command !== "string" || !TEST_COMMAND.test(command)) return []
	const text = resultText(result)
	const passed = count(text, "passed")
	const failed = count(text, "failed")
	if (!passed && !failed && !isError) return []
	return [{ kind: "tests", command: command.slice(0, 80), passed, failed, ok: !isError && failed === 0 }]
}

export function deploySignal(toolName: string, args: unknown, result: unknown, isError: boolean): Signal[] {
	if (toolName !== "bash" && toolName !== "powershell") return []
	const command = (args as { command?: unknown } | null | undefined)?.command
	const match = typeof command === "string" ? DEPLOY_COMMAND.exec(command) : null
	if (!match || typeof command !== "string") return []
	const url = /https?:\/\/[^\s"'<>)]+/.exec(resultText(result))?.[0]
	return [{ kind: "deploy", command: command.slice(0, 80), target: match[1].split(/\s+/)[0], url, ok: !isError }]
}

/** Chat tools (Slack MCP and the like): what was posted or read, by channel. */
export function messageSignal(toolName: string, args: unknown, result: unknown, isError: boolean): Signal[] {
	const service = /slack|teams|discord/i.exec(toolName)?.[0].toLowerCase()
	if (!service || isError) return []
	const a = (args ?? {}) as Record<string, unknown>
	const channel = String(a.channel ?? a.channel_id ?? a.channel_name ?? "")
	if (!channel) return []
	const posted = /post|send|reply|write/i.test(toolName)
	const text = String(posted ? (a.text ?? a.message ?? "") : resultText(result)).slice(0, 140)
	return [{ kind: "message", service, channel, text, direction: posted ? "sent" : "received" }]
}

export function detectSignals(
	toolName: string,
	args: unknown,
	result: unknown,
	isError: boolean,
	cwd: string,
	startedAt: number,
): Signal[] {
	const signals = [
		...pullRequestSignal(toolName, args, result, isError),
		...testSignal(toolName, args, result, isError),
		...deploySignal(toolName, args, result, isError),
		...messageSignal(toolName, args, result, isError),
	]
	if (isError) return signals
	for (const artifact of artifactsFromToolCall(toolName, args, result, cwd, { windowStart: startedAt - 5000 })) {
		signals.push({ kind: "artifact", path: artifact.path, name: artifact.name, origin: artifact.origin })
	}
	return signals
}
