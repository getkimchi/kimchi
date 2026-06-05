/**
 * Persistent Prompt History — load prompts from previous sessions into up/down arrow navigation.
 *
 * On session_start, discovers all user messages from past sessions in the current project
 * (via SessionManager.list + SessionManager.open) and injects them into the editor's history
 * so up-arrow can navigate across session boundaries.
 */

import type { Message, TextContent } from "@earendil-works/pi-ai"
import { CustomEditor, type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent"

const MAX_MESSAGES = 100

export default function inputHistoryExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const currentSessionFile = ctx.sessionManager.getSessionFile()
		const items = await loadRecentPrompts(ctx.cwd, currentSessionFile, MAX_MESSAGES)
		if (items.length === 0) return

		const prevFactory = ctx.ui.getEditorComponent()
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = prevFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings)
			// Load in reverse so most recent appears first in the up-arrow sequence
			for (let i = items.length - 1; i >= 0; i--) {
				editor.addToHistory?.(items[i] as string)
			}
			return editor
		})
	})
}

async function loadRecentPrompts(
	cwd: string,
	currentSessionFile: string | undefined,
	maxMessages: number,
): Promise<string[]> {
	try {
		const sessions = await SessionManager.list(cwd)
		// Most recent first
		const sorted = [...sessions].sort((a, b) => b.modified.getTime() - a.modified.getTime())

		const allMessages: string[] = []
		const seen = new Set<string>()

		for (const session of sorted) {
			if (allMessages.length >= maxMessages) break

			// Skip the current session to avoid reloading its own prompts
			if (currentSessionFile && session.path === currentSessionFile) continue

			// Skip forked/subagent sessions — their prompts are synthetic
			if (session.parentSessionPath) continue

			const userMessages = extractUserMessages(session.path).toReversed()
			for (const msg of userMessages) {
				if (allMessages.length >= maxMessages) break

				const trimmed = msg.trim()
				if (trimmed && !seen.has(trimmed) && !isSystemAnnotation(trimmed) && !isOrchestratorMessage(trimmed)) {
					seen.add(trimmed)
					allMessages.push(trimmed)
				}
			}
		}

		return allMessages
	} catch (err) {
		console.warn("[input-history] Failed to load recent prompts:", err)
		return []
	}
}

function extractUserMessages(sessionPath: string): string[] {
	try {
		const entries = SessionManager.open(sessionPath).getEntries()
		const messages: string[] = []

		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "user") continue

			const text = extractText(entry.message.content)
			if (text) messages.push(text)
		}

		return messages
	} catch (err) {
		console.warn("[input-history] Failed to extract user messages from", sessionPath, ":", err)
		return []
	}
}

/** Matches the <system-annotation> format produced by src/extensions/prompt-summary.ts. */
function isSystemAnnotation(text: string): boolean {
	return text.startsWith("<system-annotation>") && text.endsWith("</system-annotation>")
}

/** Matches the [Orchestrator… prefix defined in src/extensions/agents/manager/agent-runner.ts. */
function isOrchestratorMessage(text: string): boolean {
	return text.startsWith("[Orchestrator — automated system instruction, not a user message]")
}

function extractText(content: Message["content"]): string | null {
	if (typeof content === "string") {
		return content || null
	}

	return (
		content.find((c): c is TextContent => c.type === "text" && typeof c.text === "string" && c.text.length > 0)?.text ??
		null
	)
}
