/**
 * Session-scoped override slot for the HTTP idle timeout, set by proxy.ts's
 * configureHttpIdleTimeout for code paths that resolve settings themselves
 * (ACP session setup). Wins over the process-global settings read in
 * stream-idle-timeout.ts, loses to the env var. A getter form is accepted so
 * ACP can point at its session's own SettingsManager and see mid-session
 * settings edits live. The slot is process-global: when one ACP server hosts
 * several sessions, the last-configured session's value governs all of them —
 * per-request session scoping would need request context the global fetch
 * patch doesn't have.
 *
 * This lives in its own module with zero pi-mono deps ON PURPOSE: proxy.ts is
 * statically imported by entry.ts BEFORE PI_PACKAGE_DIR is set, and pi's
 * config.js snapshots package.json (branding, CONFIG_DIR_NAME, version) at
 * module load. Importing anything that transitively reaches
 * @earendil-works/pi-coding-agent from here would freeze pi's constants
 * unbranded for the whole process — π window title, `.pi` project config dir
 * instead of `.config/kimchi/harness` — in every compiled binary run without
 * an explicit PI_PACKAGE_DIR. Keep this module import-free.
 */

let idleTimeoutOverride: number | (() => number) | undefined

export function setStreamIdleTimeoutOverride(timeout: number | (() => number) | undefined): void {
	idleTimeoutOverride = timeout
}

export function getStreamIdleTimeoutOverride(): number | undefined {
	if (idleTimeoutOverride === undefined) return undefined
	return typeof idleTimeoutOverride === "function" ? idleTimeoutOverride() : idleTimeoutOverride
}
