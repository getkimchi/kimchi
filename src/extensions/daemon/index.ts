/**
 * Daemon extension entry point.
 *
 * Registers the `daemon` and `daemon_control` tools (see
 * `./daemon-tool.ts` for the restrictive design goal). Unlike every other
 * process-lifecycle extension in this repo, `session_shutdown` does NOT
 * kill anything here — outliving the session is the entire contract. The
 * only shutdown behavior is an interactive honesty notice: when the user
 * quits with daemons still running, say so rather than silently orphaning
 * servers on their machine.
 */
import type { ExtensionAPI, ExtensionContext, SessionShutdownEvent } from "@earendil-works/pi-coding-agent"
import { isExperimentalFeaturesEnabled } from "../experimental.js"
import { createDaemonControlToolDefinition } from "./daemon-control-tool.js"
import { createDaemonToolDefinition } from "./daemon-tool.js"
import { daemonStateDir, listDaemons } from "./state.js"

/** One line per live daemon, for the shutdown notice. */
function formatDaemonNotice(count: number, firstId: string): string {
	return count === 1
		? `1 detached daemon still running (${firstId}) — it will keep running after kimchi exits. Stop it later with: kimchi, then daemon_control stop ${firstId}`
		: `${count} detached daemons still running (${firstId}, …) — they keep running after kimchi exits. Stop later with daemon_control.`
}

/** Headless steering: services that must outlive the session need `daemon`. */
const LONG_LIVED_SERVICES_CLAUSE =
	"## Long-lived services\n\nWhen the task requires a web server or other long-lived service that a grader or user will connect to AFTER you finish, use the `daemon` tool to start it — managed background (bash + bash_control) and `&`/`nohup` processes are killed when the session ends, so the service would be dead by the time anyone connects."

export default function daemonExtension(pi: ExtensionAPI): void {
	// Headless-only steering: without the clause, the model has no reason to
	// suspect `daemon` exists and reaches for `&`/nohup (dead at exit).
	// Kept HERE (not in the questionnaire extension, where it lived briefly):
	// the daemon extension owns its discoverability, and the experimental
	// gate means the clause only appears when the tools actually do.
	pi.on("before_agent_start", (event, ctx: ExtensionContext) => {
		if (ctx.hasUI) return
		if (pi.getFlag?.("ferment-oneshot") === true) return
		if (!isExperimentalFeaturesEnabled()) return
		return { systemPrompt: `${event.systemPrompt}\n\n${LONG_LIVED_SERVICES_CLAUSE}` }
	})

	pi.on("session_start", () => {
		// EXPERIMENTAL: tools require --enable-experimental-features. cli.ts
		// already gates registration; this inner check is defense-in-depth
		// for any path that wires the extension directly (subagent sessions,
		// bespoke entry points).
		if (!isExperimentalFeaturesEnabled()) return
		pi.registerTool(createDaemonToolDefinition())
		pi.registerTool(createDaemonControlToolDefinition())
	})

	pi.on("session_shutdown", (_event: SessionShutdownEvent, ctx) => {
		if (!ctx.hasUI) return
		try {
			const live = listDaemons(daemonStateDir())
			if (live.length === 0) return
			ctx.ui.notify(formatDaemonNotice(live.length, live[0].record.id), "info")
		} catch (err) {
			// Never let a housekeeping notice break session teardown.
			console.error("daemon shutdown notice failed:", err)
		}
	})
}
