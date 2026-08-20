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
import type { ExtensionAPI, SessionShutdownEvent } from "@earendil-works/pi-coding-agent"
import { createDaemonControlToolDefinition } from "./daemon-control-tool.js"
import { createDaemonToolDefinition } from "./daemon-tool.js"
import { daemonStateDir, listDaemons } from "./state.js"

/** One line per live daemon, for the shutdown notice. */
function formatDaemonNotice(count: number, firstId: string): string {
	return count === 1
		? `1 detached daemon still running (${firstId}) — it will keep running after kimchi exits. Stop it later with: kimchi, then daemon_control stop ${firstId}`
		: `${count} detached daemons still running (${firstId}, …) — they keep running after kimchi exits. Stop later with daemon_control.`
}

export default function daemonExtension(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
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
