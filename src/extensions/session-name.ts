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

// System prompt for session name generation - keep it simple; cheap models choke
// on negative constraints, formatting demands, and multi-step instructions.
const SESSION_NAME_SYSTEM_PROMPT =
	"You are a title generator. Respond with ONLY a short title. 1-5 words, no quotes, no explanation, no markdown."

/** Max chars to feed from the user message so we don't bloat the prompt. */
const HINT_MAX_LEN = 500

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
 * Deterministic fallback: truncate name at 35 chars at last space.
 */
export function deterministicFallback(input: string): string {
	const max = 35
	if (input.length <= max) return input.trim()
	const truncated = input.slice(0, max)
	const lastSpace = truncated.lastIndexOf(" ")
	return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated).trim()
}

/**
 * Suggest a session name using the cheap Cast AI LLM.
 * Falls back to deterministic truncation on any error, with diagnostics.
 * When quiet is true, suppresses all user-facing error output (for background auto-naming).
 */
export async function suggestSessionName(ctx: ExtensionContext, hint?: string, quiet = false): Promise<string> {
	const base = basename(ctx.cwd)
	const resolvedHint = hint ?? extractFirstUserMessage(ctx)

	// If there's no user message to work with, skip the LLM entirely.
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

	const config = loadConfig()
	const apiKey = config.apiKey || process.env.KIMCHI_API_KEY || ""

	if (!apiKey) {
		if (!quiet) {
			if (ctx.hasUI) {
				ctx.ui.notify("Auto-naming: no API key configured.", "error")
			} else {
				console.error("[kimchi] auto-naming failed: no API key")
			}
		}
		return deterministicFallback(base)
	}

	try {
		const payload = {
			model: "nemotron-3-ultra-fp4",
			messages: [
				{ role: "system", content: SESSION_NAME_SYSTEM_PROMPT },
				// Frame the message exactly like shortenTitle does - cheap models need
				// an explicit task, not raw text.
				{ role: "user", content: `Short title for this conversation:\n\n${capHint(resolvedHint)}` },
			],
			// Cheap think-models spend tokens on reasoning before outputting.
			// Give enough room for both reasoning and the final title.
			max_tokens: 100,
			temperature: 0,
			reasoning_effort: "none",
		}
		const body = JSON.stringify(payload)

		const response = await fetchWithRetry(
			`${config.llmEndpoint}/chat/completions`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body,
			},
			{ timeoutMs: 10_000, retry: { maxRetries: 3 } },
		)

		if (!response.ok) {
			const errorBody = await response.text().catch(() => "")
			if (!quiet) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Auto-naming: API error ${response.status} ${response.statusText}${errorBody ? ` — ${errorBody.slice(0, 200)}` : ""}`,
						"error",
					)
				} else {
					console.error(`[kimchi] auto-naming API error: ${response.status} ${response.statusText} ${errorBody}`)
				}
			}
			return deterministicFallback(base)
		}

		const data = (await response.json()) as unknown

		const cast = data as {
			choices?: Array<{ message?: { content?: string } }>
		}
		const suggestion = cast.choices?.[0]?.message?.content?.trim() ?? ""
		if (suggestion.length > 0) {
			return suggestion
		}
		if (!quiet) {
			if (ctx.hasUI) {
				ctx.ui.notify("Auto-naming: LLM returned empty suggestion.", "error")
			} else {
				console.error("[kimchi] auto-naming: LLM returned empty suggestion")
			}
		}
		return deterministicFallback(base)
	} catch (err) {
		if (!quiet) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Auto-naming: ${err instanceof Error ? err.message : String(err)}`, "error")
			} else {
				console.error(`[kimchi] auto-naming exception: ${err}`)
			}
		}
		return deterministicFallback(base)
	}
}

export default function sessionNameExtension() {
	return (pi: ExtensionAPI) => {
		let hasAutoNamed = false

		// Auto-name sessions after the first turn when no name was set.
		pi.on("turn_end", (_event: TurnEndEvent, ctx: ExtensionContext) => {
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
			suggestSessionName(ctx, hint, true)
				.then((suggestion) => {
					if (suggestion && !ctx.sessionManager.getSessionName()) {
						pi.setSessionName(suggestion)
					}
				})
				.catch(() => {
					// Silently ignore background auto-naming failures
				})
		})
	}
}
