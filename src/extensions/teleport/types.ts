import type { ContextUsage, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import type { BearerCredentials } from "../../auth/gateway-credentials.js"

export const STATUS_KEY = "teleport"

export interface TeleportContext {
	/** Bearer plus SSO org; the org header picks the org for SSO users. */
	credentials: BearerCredentials
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
