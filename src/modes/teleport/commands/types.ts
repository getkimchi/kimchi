import type {
	AgentSession,
	AgentSessionServices,
	ExtensionUIContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent"
import type { TeleportableAgentSession } from "../proxy/teleportable-session.js"

export interface TeleportContext {
	wrapper: TeleportableAgentSession
	services: AgentSessionServices
	apiKey: string
	endpoint?: string
	cwd: string
	ui: ExtensionUIContext
	signal?: AbortSignal
	/** Path to the global config file (for git token persistence). */
	configPath?: string
	/**
	 * Asks InteractiveMode to re-bind its session listeners to the wrapper's
	 * current foreground. Must be invoked after `wrapper.foregroundRemote` or
	 * `wrapper.detachToHomeBase`, otherwise the TUI stays bound to the old
	 * session and the editor appears frozen. Captured by run-interactive-teleport.
	 */
	triggerRebind?: () => Promise<void>
	/**
	 * Mirrors pi-mono's post-`switchSession` UI reset: clears extension
	 * overlays/shortcuts/widgets and resets the chat container to the new
	 * foreground's message history. Required *after* `triggerRebind` so the
	 * editor reflects the swapped foreground; without it the chat keeps
	 * showing the previous session's state and submits look like they do
	 * nothing.
	 */
	triggerFreshUI?: () => void
	/**
	 * Called with the resolved host string right before the UI refresh that
	 * follows a foreground swap. The teleport extension uses this to set the
	 * session indicator **before** `resetExtensionUI` + `rebindCurrentSession`
	 * re-create the prompt editor, so the editor factory picks up the
	 * indicator text from the module-level cache on first render.
	 */
	onHostResolved?: (host: string) => void
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
