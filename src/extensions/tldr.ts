import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { loadConfig } from "../config.js"
import { fetchWithRetry } from "../utils/http.js"

export const TLDR_MODEL = "deepseek-v4-flash"

const TLDR_TIMEOUT_MS = 8000
const TLDR_MAX_RETRIES = 0
const TLDR_MAX_TOKENS = 160
const TLDR_MAX_ENTRIES = 14
const MAX_ANSWER_CHARS = 400

export const DEFAULT_TLDR_QUESTION = "What are you doing right now?"

const TLDR_SYSTEM_PROMPT =
	"You report the status of a coding agent session. Answer the user's question about what the agent is doing, based strictly on the provided activity log. Reply with at most two short sentences of plain text: no markdown, no lists, no quotes, no preamble. Be concrete about files, commands, and tools. If there is no activity, say the agent has done nothing yet."

export interface TldrToolStatus {
	toolName: string
	argsSummary: string
	elapsedMs: number
}

export function truncateText(text: string, max: number): string {
	const normalized = text.trim().replace(/\s+/g, " ")
	if (normalized.length <= max) return normalized
	const cut = normalized.slice(0, max)
	const lastSpace = cut.lastIndexOf(" ")
	return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

const TOOL_ARG_KEYS = [
	"command",
	"cmd",
	"script",
	"path",
	"file",
	"pattern",
	"query",
	"description",
	"prompt",
	"url",
	"name",
]

export function describeToolArgs(args: unknown): string {
	if (typeof args !== "object" || args === null) return ""
	const record = args as Record<string, unknown>
	const parts: string[] = []
	for (const key of TOOL_ARG_KEYS) {
		const value = record[key]
		if (typeof value === "string" && value.length > 0) {
			parts.push(`${key}="${truncateText(value, 80)}"`)
			if (parts.length >= 2) break
		}
	}
	return parts.join(" ")
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim()
	if (!Array.isArray(content)) return ""
	const texts: string[] = []
	for (const part of content) {
		if (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text") {
			const text = (part as { text?: unknown }).text
			if (typeof text === "string" && text.trim().length > 0) texts.push(text.trim())
		}
	}
	return texts.join(" ")
}

export function formatSessionTail(entries: readonly unknown[]): string[] {
	const lines: string[] = []
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue
		const { type, message } = entry as { type?: unknown; message?: unknown }
		if (type !== "message" || typeof message !== "object" || message === null) continue
		const msg = message as { role?: unknown; content?: unknown; toolName?: unknown; isError?: unknown }
		if (msg.role === "user") {
			const text = extractText(msg.content)
			if (text) lines.push(`user: ${truncateText(text, 200)}`)
		} else if (msg.role === "assistant") {
			if (!Array.isArray(msg.content)) continue
			for (const part of msg.content) {
				if (typeof part !== "object" || part === null) continue
				const p = part as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown }
				if (p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0) {
					lines.push(`assistant: ${truncateText(p.text, 200)}`)
				} else if (p.type === "toolCall" && typeof p.name === "string") {
					lines.push(`assistant tool call: ${p.name}(${describeToolArgs(p.arguments)})`)
				}
			}
		} else if (msg.role === "toolResult") {
			const text = extractText(msg.content)
			if (text) {
				const name = typeof msg.toolName === "string" ? ` (${msg.toolName})` : ""
				const prefix = msg.isError ? "error" : "tool result"
				lines.push(`${prefix}${name}: ${truncateText(text, 150)}`)
			}
		}
	}
	return lines.slice(-TLDR_MAX_ENTRIES)
}

export function createInFlightTracker() {
	const tools = new Map<string, { toolName: string; startedAt: number; argsSummary: string }>()
	return {
		start(toolCallId: string, toolName: string, args: unknown): void {
			tools.set(toolCallId, { toolName, startedAt: Date.now(), argsSummary: describeToolArgs(args) })
		},
		end(toolCallId: string): void {
			tools.delete(toolCallId)
		},
		snapshot(): TldrToolStatus[] {
			const now = Date.now()
			return [...tools.values()].map((tool) => ({
				toolName: tool.toolName,
				argsSummary: tool.argsSummary,
				elapsedMs: now - tool.startedAt,
			}))
		},
	}
}

export function buildActivitySection(
	tail: readonly string[],
	inFlight: readonly TldrToolStatus[],
	turnActive: boolean,
): string {
	const sections: string[] = []
	if (inFlight.length > 0) {
		const lines = inFlight.map((tool) => {
			const seconds = Math.max(1, Math.round(tool.elapsedMs / 1000))
			const args = tool.argsSummary ? `(${tool.argsSummary})` : ""
			return `- ${tool.toolName}${args} — running for ${seconds}s`
		})
		sections.push(`Currently executing tools:\n${lines.join("\n")}`)
	} else if (turnActive) {
		sections.push("The agent is currently generating a response from the model (no tool is running right now).")
	} else {
		sections.push("The agent is idle.")
	}
	if (tail.length > 0) {
		sections.push(`Recent activity (oldest first):\n${tail.join("\n")}`)
	}
	return sections.join("\n\n")
}

export function deterministicTldr(
	tail: readonly string[],
	inFlight: readonly TldrToolStatus[],
	turnActive: boolean,
): string {
	const lastLine = tail[tail.length - 1]
	if (inFlight.length > 0) {
		const latest = inFlight[inFlight.length - 1]
		const seconds = Math.max(1, Math.round(latest.elapsedMs / 1000))
		const args = latest.argsSummary ? `(${latest.argsSummary})` : ""
		const extra = inFlight.length > 1 ? `, plus ${inFlight.length - 1} more tool${inFlight.length > 2 ? "s" : ""}` : ""
		const first = `Running ${latest.toolName}${args} for ${seconds}s${extra}.`
		if (lastLine) return `${first} Before that: ${truncateText(lastLine, 160)}`
		return first
	}
	if (turnActive) {
		if (lastLine) return `Waiting on the model's response. Last activity: ${truncateText(lastLine, 160)}`
		return "Working on a response."
	}
	if (lastLine) return `Idle. Last activity: ${truncateText(lastLine, 200)}`
	return "No activity in this session yet."
}

export function cleanupAnswer(raw: string): string {
	let text = raw.trim().replace(/\s+/g, " ")
	text = text.replace(/^["'`]+|["'`]+$/g, "")
	if (text.length > MAX_ANSWER_CHARS) text = truncateText(text, MAX_ANSWER_CHARS)
	return text
}

export async function requestTldrAnswer(
	ctx: ExtensionContext,
	question: string,
	activity: string,
): Promise<string | null> {
	const config = loadConfig({ cwd: ctx.cwd })
	const apiKey = config.apiKey || process.env.KIMCHI_API_KEY || ""
	if (!apiKey) return null

	const response = await fetchWithRetry(
		`${config.llmEndpoint.replace(/\/+$/, "")}/chat/completions`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model: TLDR_MODEL,
				messages: [
					{ role: "system", content: TLDR_SYSTEM_PROMPT },
					{ role: "user", content: `${question}\n\n${activity}` },
				],
				max_tokens: TLDR_MAX_TOKENS,
				temperature: 0,
			}),
		},
		{ timeoutMs: TLDR_TIMEOUT_MS, retry: { maxRetries: TLDR_MAX_RETRIES } },
	)

	if (!response.ok) return null
	const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
	const content = data.choices?.[0]?.message?.content
	if (typeof content !== "string" || content.trim().length === 0) return null
	return cleanupAnswer(content)
}

export default function tldrExtension() {
	return (pi: ExtensionAPI) => {
		const tracker = createInFlightTracker()
		let turnActive = false

		pi.on("agent_start", () => {
			turnActive = true
		})
		pi.on("agent_end", () => {
			turnActive = false
		})
		pi.on("tool_execution_start", (event) => {
			tracker.start(event.toolCallId, event.toolName, event.args)
		})
		pi.on("tool_execution_end", (event) => {
			tracker.end(event.toolCallId)
		})

		pi.registerCommand("tldr", {
			description: "Quick status: what the agent is doing right now (does not interrupt the session)",
			handler: async (args, ctx) => {
				const question = args.trim() || DEFAULT_TLDR_QUESTION
				const tail = formatSessionTail(ctx.sessionManager.getBranch())
				const activity = buildActivitySection(tail, tracker.snapshot(), turnActive)

				let answer: string | null = null
				try {
					answer = await requestTldrAnswer(ctx, question, activity)
				} catch {
					answer = null
				}

				const text = answer ?? deterministicTldr(tail, tracker.snapshot(), turnActive)
				if (ctx.hasUI) {
					ctx.ui.notify(`tldr: ${text}`, "info")
				}
			},
		})
	}
}
