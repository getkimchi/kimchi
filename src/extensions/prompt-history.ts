/**
 * prompt-history — Cross-session prompt history persistence.
 *
 * Reads/writes ~/.config/kimchi/prompt-history.json so the up/down arrow
 * history in the editor survives restarts.
 *
 * - session_start: loads saved entries and feeds them into the editor's
 *   addToHistory() via setImmediate (after ui.ts has installed the editor).
 * - input: prepends each non-empty, non-duplicate submission, caps at 500
 *   entries, writes atomically (.tmp + renameSync).
 *
 * All disk I/O is wrapped in try/catch — never throws.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, InputEvent } from "@earendil-works/pi-coding-agent"
import { currentEditor } from "./ui.js"

const HISTORY_FILE = join(homedir(), ".config", "kimchi", "prompt-history.json")
const MAX_HISTORY = 500

interface PromptHistory {
	history: string[]
}

function loadHistory(): string[] {
	try {
		const raw = readFileSync(HISTORY_FILE, "utf-8")
		const parsed = JSON.parse(raw) as PromptHistory
		if (Array.isArray(parsed.history)) return parsed.history
	} catch {
		// file missing or corrupt — start fresh
	}
	return []
}

function saveHistory(history: string[]): void {
	try {
		const dir = join(homedir(), ".config", "kimchi")
		mkdirSync(dir, { recursive: true })
		const tmp = `${HISTORY_FILE}.tmp`
		writeFileSync(tmp, JSON.stringify({ history }, null, 2), "utf-8")
		renameSync(tmp, HISTORY_FILE)
	} catch {
		// best-effort; never throw
	}
}

export default function promptHistoryExtension(pi: ExtensionAPI) {
	pi.on("session_start", () => {
		const history = loadHistory()
		if (history.length === 0) return

		setImmediate(() => {
			// Reverse order so oldest is added first — addToHistory prepends,
			// making the final in-memory array index 0 = most recent.
			for (let i = history.length - 1; i >= 0; i--) {
				(currentEditor as any)?.addToHistory?.(history[i])
			}
		})
	})

	pi.on("input", (event: InputEvent) => {
		const text = event.text.trim()
		if (!text) return

		const history = loadHistory()

		// Skip consecutive duplicate of the last entry
		if (history.length > 0 && history[0] === text) return

		history.unshift(text)

		// Cap at MAX_HISTORY
		if (history.length > MAX_HISTORY) {
			history.length = MAX_HISTORY
		}

		saveHistory(history)
	})
}
