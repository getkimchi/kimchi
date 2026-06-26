/**
 * Repair-on-load: rewrite persisted session JSONL to drop orphaned toolResults.
 *
 * On `session_start` (resume / fork / reload / startup — any load), read the
 * session `.jsonl` file, detect toolResult messages whose matching assistant
 * toolCall is absent anywhere in the file, and rewrite the file in place with
 * those lines removed. A `.bak` backup of the original bytes is written first.
 *
 * Why this exists: a compaction boundary (or any history-rewriting operation)
 * can drop an assistant toolCall whose matching toolResult is appended later.
 * The orphaned toolResult then sits latent in the persisted JSONL — a permissive
 * provider continues, but resuming into a strict provider (Anthropic) fails hard
 * (`unexpected tool_use_id`). Phase 1 sanitizes outgoing requests defensively;
 * phase 2 prevents new orphans at the compaction boundary. This phase 3 hook
 * repairs ALREADY-poisoned persisted history so a previously-broken session
 * recovers without manual JSONL editing.
 *
 * Safety contract (must never throw, must never corrupt):
 *  - All fs access is wrapped in try/catch; on ANY failure the original file is
 *    left untouched and the error is swallowed (debug log only).
 *  - A `.bak` backup of the original bytes is written before any rewrite.
 *  - The rewrite is idempotent: re-running on a clean file drops nothing and
 *    produces byte-equivalent output.
 *  - Malformed JSONL lines are kept as-is (never dropped, never rewritten).
 *  - Non-message entries (compaction, model-change, custom, etc.) are always kept.
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { findOrphanedToolResults } from "../orphan-tool-result-sanitizer.js"

/** A function that detects orphaned toolCallIds in a message array. */
export type OrphanDetector = (messages: ReadonlyArray<unknown>) => string[]

/** Shape of a parsed session JSONL message entry (the relevant subset). */
interface ParsedMessageEntry {
	type: "message"
	message: { role?: string; toolCallId?: string; content?: unknown }
}

/** Shape of any parsed session JSONL line. */
interface ParsedLine {
	type?: string
	message?: unknown
}

/**
 * Pure, idempotent rewriter: given the raw JSONL lines of a session file and an
 * orphan detector (defaults to `findOrphanedToolResults` from phase 1), return
 * the filtered lines with orphaned toolResult entries removed.
 *
 * Algorithm (two-pass):
 *  1. Parse every line. Collect the `message` of every `type: "message"` entry
 *     into a flat array — this is the message set the detector runs against.
 *  2. Call `orphanDetector(messages)` → set of orphaned toolCallIds.
 *  3. Re-walk lines: drop a line iff it is a `type: "message"` entry whose
 *     `message.role === "toolResult"` AND `message.toolCallId` is in the orphan
 *     set. All other lines (assistant, user, compaction, custom, malformed) are
 *     kept verbatim.
 *
 * Never throws: malformed lines (JSON parse failure) are kept as-is. Returns
 * `{ rewritten, dropped }` where `rewritten` is the new line array and `dropped`
 * is the count of removed lines.
 */
export function rewriteSessionJsonl(
	jsonlLines: ReadonlyArray<string>,
	orphanDetector: OrphanDetector = findOrphanedToolResults,
): { rewritten: string[]; dropped: number } {
	// Pass 1: parse every line, collect messages from message entries.
	const parsed: { raw: string; value: ParsedLine | null }[] = []
	const messages: unknown[] = []

	for (const raw of jsonlLines) {
		if (typeof raw !== "string" || raw.length === 0) {
			parsed.push({ raw, value: null })
			continue
		}
		let value: ParsedLine | null = null
		try {
			value = JSON.parse(raw) as ParsedLine
		} catch {
			value = null
		}
		parsed.push({ raw, value })
		if (value && value.type === "message" && value.message && typeof value.message === "object") {
			messages.push(value.message)
		}
	}

	const orphanIds = orphanDetector(messages)
	if (orphanIds.length === 0) {
		// Fast path: no orphans — return the original lines unchanged (byte-equivalent).
		return { rewritten: [...jsonlLines], dropped: 0 }
	}

	const orphanSet = new Set(orphanIds)
	const rewritten: string[] = []
	let dropped = 0

	for (const { raw, value } of parsed) {
		// Malformed or non-message lines are always kept.
		if (!value || value.type !== "message") {
			rewritten.push(raw)
			continue
		}
		const msg = value.message as { role?: string; toolCallId?: unknown }
		// Drop only orphaned toolResult entries.
		if (msg && msg.role === "toolResult" && typeof msg.toolCallId === "string" && orphanSet.has(msg.toolCallId)) {
			dropped++
			continue
		}
		rewritten.push(raw)
	}

	return { rewritten, dropped }
}

/**
 * Extension factory: registers a `session_start` handler that repairs the
 * persisted session JSONL in place on any load (resume / fork / reload /
 * startup — a fresh `new` session has no file yet, so the handler is a no-op).
 *
 * Drop-silent: emits a debug-level log line only. Never throws — on any fs
 * error the original file is left untouched.
 */
const orphanToolResultRepairExtension: ExtensionFactory = (pi: ExtensionAPI) => {
	pi.on("session_start", async (_event: unknown, ctx: unknown) => {
		try {
			const sessionFile: string | undefined = (
				ctx as { sessionManager?: { getSessionFile?: () => string | undefined } }
			)?.sessionManager?.getSessionFile?.()
			if (!sessionFile) return

			const fs = await import("node:fs")
			const path = await import("node:path")

			let originalText: string
			try {
				originalText = fs.readFileSync(sessionFile, "utf8")
			} catch {
				// File may not exist yet (new session) — nothing to repair.
				return
			}

			// Split into lines. If the file ends with a trailing newline, split
			// produces a trailing "" element which rewriteSessionJsonl keeps as a
			// malformed line — so join("\n") preserves the trailing newline.
			// \r\n line endings are preserved because \r stays attached to each line.
			const lines = originalText.split("\n")

			const { rewritten, dropped } = rewriteSessionJsonl(lines)
			if (dropped === 0) return

			// Write a .bak backup of the ORIGINAL bytes before any rewrite.
			const backupPath = `${sessionFile}.bak`
			try {
				fs.copyFileSync(sessionFile, backupPath)
			} catch {
				// If we can't write the backup, do NOT rewrite — leave the original
				// untouched. Phase 1's outgoing sanitizer remains the hard guarantee.
				return
			}

			// Atomically rewrite: write to a temp file then rename over the original.
			// join("\n") reconstructs the original line-ending style because split
			// preserved \r on each line and the trailing "" element.
			const tmpPath = `${sessionFile}.repair-tmp`
			fs.writeFileSync(tmpPath, rewritten.join("\n"), "utf8")
			fs.renameSync(tmpPath, sessionFile)

			try {
				console.debug?.(
					`[session-repair] dropped ${dropped} orphaned toolResult(s) from ${path.basename(sessionFile)} (backup: ${path.basename(backupPath)})`,
				)
			} catch {
				// console.debug may be undefined — never throw.
			}
		} catch {
			// Last-resort: swallow everything. Never throw from a session_start hook.
		}
	})
}

export default orphanToolResultRepairExtension
