/**
 * Upstream internals Kimchi reaches into outside of patches/. Runtime prototype patches fail at
 * runtime, not at build, and whole-file overwrites silently discard upstream changes — so the
 * upgrade report compares each of these between the baseline and target tarballs.
 *
 * Keep in sync when adding a runtime patch; internals.test.ts checks each entry is still referenced.
 */

export interface HookedMethod {
	pkg: string
	/** Path inside the npm package where the member is defined. */
	distFile: string
	name: string
	/** Kimchi file that hooks or reads the member. */
	hookedBy: string
}

const AGENT_SESSION = "dist/core/agent-session.js"
const INTERACTIVE_MODE = "dist/modes/interactive/interactive-mode.js"

const session = (name: string, hookedBy: string): HookedMethod => ({
	pkg: "pi-coding-agent",
	distFile: AGENT_SESSION,
	name,
	hookedBy,
})
const interactive = (name: string, hookedBy: string): HookedMethod => ({
	pkg: "pi-coding-agent",
	distFile: INTERACTIVE_MODE,
	name,
	hookedBy,
})

export const HOOKED_METHODS: HookedMethod[] = [
	session("_isRetryableError", "src/upstream-retry-patch.ts"),
	session("_prepareRetry", "src/upstream-retry-patch.ts"),
	session("_checkCompaction", "src/upstream-retry-patch.ts"),
	session("_retryAttempt", "src/upstream-retry-patch.ts"),
	session("_retryAbortController", "src/upstream-retry-patch.ts"),
	session("_runAutoCompaction", "src/upstream-retry-patch.ts"),
	session("_handlePostAgentRun", "src/upstream-retry-patch.ts"),
	session("_emit", "src/upstream-retry-patch.ts"),
	session("_overflowRecoveryAttempted", "src/upstream-retry-patch.ts"),
	session("_compactionAbortController", "src/upstream-inline-compact-patch.ts"),
	session("_autoCompactionAbortController", "src/upstream-inline-compact-patch.ts"),
	session("_disconnectFromAgent", "src/upstream-inline-compact-patch.ts"),
	session("_bindExtensionCore", "src/upstream-inline-compact-patch.ts"),
	interactive("uncaughtCrash", "src/uncaught-epipe-patch.ts"),
	interactive("createExtensionUIContext", "src/paste-to-editor-patch.ts"),
	interactive("bindCurrentSessionExtensions", "src/extensions/interactive-model-session.ts"),
]

export interface OverwrittenFile {
	pkg: string
	distFile: string
	by: string
}

export const OVERWRITTEN_FILES: OverwrittenFile[] = [
	{ pkg: "pi-ai", distFile: "dist/utils/oauth-page.js", by: "scripts/patch-pi-ai-oauth.js" },
]

/** Every Kimchi file whose change can alter what the upgrade report says about internals. */
export const HOOKED_FILES: string[] = [
	...new Set([...HOOKED_METHODS.map((m) => m.hookedBy), ...OVERWRITTEN_FILES.map((f) => f.by)]),
]
