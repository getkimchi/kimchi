import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { setSettingsProjectTrusted } from "../settings-watcher.js"
import { isStaleCtxError } from "./stale-ctx.js"

/**
 * Syncs the session's project-trust decision onto the process-global settings
 * reader (src/settings-watcher.ts) at session start — before the first model
 * request.
 *
 * The settings watcher bootstraps with project settings untrusted; without this
 * sync, trust only reaches it opportunistically through the compaction paths
 * (model-guard, ferment auto-compaction), which fire late in a session or never.
 * Until then every read that consults project scope silently falls back to
 * global/default values — most visibly `httpIdleTimeoutMs`, where a trusted
 * project's opt-out (`0`) would be ignored and streams killed at the default
 * deadline (see resolveStreamIdleTimeoutMs in src/http/stream-idle-timeout.ts).
 *
 * Pi resolves project trust during startup, before extensions load, so by
 * session_start ctx.isProjectTrusted() is settled and a one-shot sync per
 * session is sufficient.
 */
export default function settingsTrustSyncExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		try {
			const trusted = ctx.isProjectTrusted?.()
			if (trusted !== undefined) setSettingsProjectTrusted(trusted)
		} catch (err) {
			// Stale-ctx errors are routine (post-shutdown/reload); anything else is
			// warned so a broken trust accessor doesn't fail invisibly.
			if (!isStaleCtxError(err)) {
				console.warn("[settings-trust-sync] failed to sync project trust:", err)
			}
		}
	})
}
