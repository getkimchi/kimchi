import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { setProjectScopeTrusted } from "../project-scope-trust.js"
import { invalidateResourceDefinitionsCache } from "../resources/definitions.js"
import { setSettingsProjectTrusted } from "../settings-watcher.js"
import { isStaleCtxError } from "./stale-ctx.js"

/**
 * Syncs the session's project-trust decision onto the process-global settings
 * reader (src/settings-watcher.ts) and the kimchi project-scope gate
 * (src/project-scope-trust.ts) at session start — before the first model
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
 * The kimchi project-scope gate gates every reader of project-local `.kimchi/`
 * and `.claude/` resources (config, permissions, hooks, skills, agents,
 * memory, tags, plans). It fails closed by default, so this sync is what lets
 * a trusted project's resources take effect; the resource-definitions cache is
 * invalidated so project hooks and claude-code hooks discovered before the sync
 * (or the lack thereof) are re-scanned under the new decision.
 *
 * Pi resolves project trust during startup, before extensions load, so by
 * session_start ctx.isProjectTrusted() is settled and a one-shot sync per
 * session is sufficient.
 */
export default function settingsTrustSyncExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		try {
			const trusted = ctx.isProjectTrusted?.()
			if (trusted !== undefined) {
				setSettingsProjectTrusted(trusted)
				if (ctx.cwd) {
					setProjectScopeTrusted(ctx.cwd, trusted)
					invalidateResourceDefinitionsCache()
				}
			}
		} catch (err) {
			// Stale-ctx errors are routine (post-shutdown/reload); anything else is
			// warned so a broken trust accessor doesn't fail invisibly.
			if (!isStaleCtxError(err)) {
				console.warn("[settings-trust-sync] failed to sync project trust:", err)
			}
		}
	})
}
