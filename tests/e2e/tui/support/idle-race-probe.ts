// Regression probe for the before_agent_start idle race (kimchi PR: fix/before-agent-start-idle).
//
// Reproduces the invariant the kimchi-workflows bridge depends on: while an
// async before_agent_start handler is pending (memory's turn-1 digest, for
// example), the session must not report idle. The
// bridge's watcher resolves waitForIdle during that window on unfixed pi and
// fails the step ("became idle without the run settling").
//
// Detection is timing-based and self-contained: the watcher must not resolve
// before the before_agent_start handler has finished, because the turn it
// waits for cannot start until that handler returns.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/** Artificial pre-turn latency: what a slow digest or scope network call costs. */
const PRE_TURN_DELAY_MS = 300

export default function idleRaceProbe(pi: ExtensionAPI): void {
	let beforeAgentDoneAt: number | undefined

	// Simulates the async pre-turn work real extensions do.
	pi.on("before_agent_start", async () => {
		await new Promise((settle) => setTimeout(settle, PRE_TURN_DELAY_MS))
		beforeAgentDoneAt = Date.now()
	})

	pi.registerCommand("idle-probe", {
		description: "Reproduce the workflows-bridge idle-watcher race against before_agent_start",
		handler: async (_args, ctx) => {
			const outcome = await new Promise<string>((resolve) => {
				// The bridge's turn trigger: fire-and-forget custom message.
				pi.sendMessage(
					{ customType: "idle-race-probe", content: [{ type: "text", text: "probe turn" }], display: true },
					{ triggerTurn: true },
				)
				// The bridge's idle watcher: waitForIdle must pend through the
				// pre-turn window; resolving before the before_agent_start handler
				// finished means the session reported idle mid-preparation.
				void (async () => {
					await ctx.waitForIdle()
					const watcherResolvedAt = Date.now()
					await new Promise((settle) => setTimeout(settle, 0))
					const resolvedEarly = beforeAgentDoneAt === undefined || watcherResolvedAt < beforeAgentDoneAt
					resolve(resolvedEarly ? "idle-crash" : "settled")
				})()
			})

			const label = outcome === "idle-crash" ? "IDLE-RACE-CRASHED" : "IDLE-RACE-SETTLED"
			ctx.ui.notify(label, outcome === "idle-crash" ? "error" : "info")
		},
	})
}
