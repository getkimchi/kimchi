/**
 * Session Name Extension
 *
 * Auto-names sessions from the first few user messages after the first turn.
 * Everything else (manual rename, --name flag, terminal title, get_session_name tool)
 * is handled upstream by pi-coding-agent.
 */

import { basename } from "node:path"
import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent"

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
	if (input.length <= max) return input.trim()
	const truncated = input.slice(0, max)
	const lastSpace = truncated.lastIndexOf(" ")
	return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated).trim()
}

/**
 * Suggest a session name from the first user text.
 * When quiet is true, suppresses all user-facing error output.
 */
export function suggestSessionName(ctx: ExtensionContext, hint?: string, quiet = false): string {
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

	return deterministicFallback(resolvedHint)
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
			const suggestion = suggestSessionName(ctx, hint, true)
			if (suggestion && !ctx.sessionManager.getSessionName()) {
				pi.setSessionName(suggestion)
			}
		})
	}
}
