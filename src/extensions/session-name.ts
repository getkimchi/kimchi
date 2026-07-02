/**
 * Session Name Extension
 *
 * Auto-names sessions from the first few user messages after the first turn.
 * Everything else (manual rename, --name flag, terminal title, get_session_name tool)
 * is handled upstream by pi-coding-agent.
 */

import { basename } from "node:path"
import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent"
import { loadConfig } from "../config.js"
import { fetchWithRetry } from "../utils/http.js"

export const SESSION_NAME_MODEL = "deepseek-v4-flash"
const SESSION_NAME_SYSTEM_PROMPT =
	"You are a title generator. Respond with ONLY a short title. 1-5 words, no quotes, no explanation, no markdown."
const HINT_MAX_LEN = 500
const SESSION_NAME_TIMEOUT_MS = 10_000

function capHint(hint: string): string {
	if (hint.length <= HINT_MAX_LEN) return hint
	return `${hint.slice(0, HINT_MAX_LEN).trimEnd()}...`
}

/**
 * Extract the earliest user messages from the session.
 * We search from the START (oldest) because the first message typically
 * describes the actual task — later messages are just follow-ups,
 * confirmations, or corrections ("yeah", "apply it", etc.).
 */
export function extractFirstUserMessage(ctx: ExtensionContext): string | null {
	const branch = ctx.sessionManager.getBranch()
	const fromBranch = extractEarlyUserText(branch)
	if (fromBranch) return fromBranch

	const entries = ctx.sessionManager.getEntries()
	return extractEarlyUserText(entries)
}

type SessionEntries = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>

/**
 * Iterate forward and collect text from the first few user messages.
 * Bundles up to 3 messages for richer context, capped in total length.
 */
function extractEarlyUserText(entries: SessionEntries): string | null {
	const texts: string[] = []
	for (const entry of entries) {
		if (entry.type !== "message") continue
		const msg = entry.message
		if (msg.role !== "user") continue
		if (!("content" in msg)) continue

		let text: string | null = null
		if (typeof msg.content === "string") {
			text = msg.content.trim()
		} else if (Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (
					typeof part === "object" &&
					part !== null &&
					"type" in part &&
					(part as { type: string }).type === "text" &&
					"text" in (part as { text?: string })
				) {
					text = (part as { text: string }).text.trim()
					break
				}
			}
		}

		if (text && text.length > 0) {
			texts.push(text)
			if (texts.length >= 3) break
		}
	}

	if (texts.length === 0) return null
	return texts.join("\n---\n")
}

/**
 * Deterministic title: truncate name at 35 chars at last space.
 */
export function deterministicFallback(input: string): string {
	const max = 35
	const normalized = input.trim().replace(/\s+/g, " ")
	if (normalized.length <= max) return normalized
	const truncated = normalized.slice(0, max)
	const lastSpace = truncated.lastIndexOf(" ")
	return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated).trim()
}

/**
 * Suggest a session name from the first user text.
 * When quiet is true, suppresses all user-facing error output.
 */
export async function suggestSessionName(ctx: ExtensionContext, hint?: string, quiet = false): Promise<string> {
	const base = basename(ctx.cwd)
	const resolvedHint = hint ?? extractFirstUserMessage(ctx)

	if (!resolvedHint) {
		if (!quiet) {
			if (ctx.hasUI) {
				ctx.ui.notify("Auto-naming: no user message found in this session yet.", "error")
			} else {
				console.error("[kimchi] auto-naming failed: no user message found")
			}
		}
		return deterministicFallback(base)
	}

	const fallback = deterministicFallback(resolvedHint)
	const config = loadConfig({ cwd: ctx.cwd })
	const apiKey = config.apiKey || process.env.KIMCHI_API_KEY || ""

	if (!apiKey) return fallback

	try {
		const response = await fetchWithRetry(
			`${config.llmEndpoint.replace(/\/+$/, "")}/chat/completions`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					model: SESSION_NAME_MODEL,
					messages: [
						{ role: "system", content: SESSION_NAME_SYSTEM_PROMPT },
						{ role: "user", content: `Short title for this conversation:\n\n${capHint(resolvedHint)}` },
					],
					max_tokens: 32,
					temperature: 0,
				}),
			},
			{ timeoutMs: SESSION_NAME_TIMEOUT_MS, retry: { maxRetries: Math.min(config.retry.maxRetries, 2) } },
		)

		if (!response.ok) {
			if (!quiet) {
				const errorBody = await response.text().catch(() => "")
				const message = `Auto-naming: API error ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody.slice(0, 200)}` : ""}`
				if (ctx.hasUI) ctx.ui.notify(message, "error")
				else console.error(`[kimchi] ${message}`)
			}
			return fallback
		}

		const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
		const suggestion = data.choices?.[0]?.message?.content?.trim()
		return suggestion ? deterministicFallback(suggestion) : fallback
	} catch (err) {
		if (!quiet) {
			const message = `Auto-naming: ${err instanceof Error ? err.message : String(err)}`
			if (ctx.hasUI) ctx.ui.notify(message, "error")
			else console.error(`[kimchi] ${message}`)
		}
		return fallback
	}
}

export default function sessionNameExtension() {
	return (pi: ExtensionAPI) => {
		let hasAutoNamed = false

		// Auto-name sessions after the first turn when no name was set.
		pi.on("turn_end", async (_event: TurnEndEvent, ctx: ExtensionContext) => {
			if (hasAutoNamed) return
			if (ctx.sessionManager.getSessionName()) {
				hasAutoNamed = true
				return
			}
			const hint = extractFirstUserMessage(ctx)
			if (!hint) {
				hasAutoNamed = true
				return
			}
			hasAutoNamed = true
			const suggestion = await suggestSessionName(ctx, hint, true)
			if (suggestion && !ctx.sessionManager.getSessionName()) {
				pi.setSessionName(suggestion)
			}
		})
	}
}
