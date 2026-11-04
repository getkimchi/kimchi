// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import type { ContextUsage, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"

export const STATUS_KEY = "teleport"

export interface TeleportContext {
	apiKey: string
	endpoint?: string
	cwd: string
	configPath?: string
	signal?: AbortSignal
	ui: ExtensionCommandContext["ui"]
	/** Path to the local harness session.jsonl, if a session is active. */
	sessionFile?: string
	/**
	 * Live context-usage probe for the active session (same data as the footer).
	 * `tokens` is null right after compaction, until the next LLM response.
	 */
	getContextUsage?: () => ContextUsage | undefined
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
