import type { AgentSession, AgentSessionServices, ExtensionUIContext } from "@earendil-works/pi-coding-agent"

export interface TeleportContext {
	session: AgentSession
	services: AgentSessionServices
	apiKey: string
	endpoint?: string
	cwd: string
	ui: ExtensionUIContext
	signal?: AbortSignal
	/** Path to the global config file (for git token persistence). */
	configPath?: string
	/**
	 * Tracks which remote session IDs have had git credentials synced
	 * during this CLI run. Prevents redundant SSH calls on repeated
	 * /attach or /connect invocations to the same session.
	 */
	gitCredentialsSynced: Set<string>
	/**
	 * The most recently used remote session ID, set by /teleport and /attach.
	 * Used by /connect and /sync when invoked without an explicit target.
	 */
	lastSessionId?: string
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const STATUS_KEY = "teleport"

export const SANDBOX_USER = "sandbox"
export const SANDBOX_HOME = "/home/sandbox"
export const FALLBACK_TARGET_NAME = "workspace"

export const WORKSPACE_WARN_BYTES = 500 * 1024 * 1024
export const WORKSPACE_REFUSE_BYTES = 5 * 1024 * 1024 * 1024
export const BUSY_WAIT_MS_LOCAL = 5_000
export const BUSY_WAIT_MS_REMOTE = 10_000
