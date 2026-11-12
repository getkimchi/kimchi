/**
 * Background-bash extension entry point.
 *
 * On `session_start`, re-registers the `bash` tool with the background
 * execution definition from `./bash-background-tool.ts`. Because the
 * extension runner resolves tool-name collisions by FIRST registration
 * (runner.js `getAllRegisteredTools`: first-per-name wins, iterating
 * extensions in array order), this extension MUST be placed BEFORE
 * `bashToolGuardExtension` in the `src/cli.ts` extensions array so its
 * background `execute` wins. The description is set to the bash-tool-guard
 * steering text so the tool-selection preference composes instead of being
 * clobbered (the tool-guard's own re-registration then becomes a no-op for
 * the description — same string — and its `tool_call` steering still fires
 * because the tool name stays `bash`).
 *
 * A single session-scoped state ({registry, coordinator, limitSeconds}) is
 * created per session (stored in `./session-registry.ts` so consumers
 * don't import this barrel). The registry owns process lifecycle and the
 * harness safety limit (`--bash-process-limit`, default one hour); the
 * coordinator owns per-command handoff deadlines and bounded cohort
 * waits. Both are torn down on `session_shutdown`.
 */
import type { ExtensionAPI, SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent"
import { resolveBashProcessLimitSeconds } from "../../cli-args.js"
import { SHELLS_STATUS_KEY } from "../../components/status-line.js"
import {
	BASH_BACKGROUND_SETTLE_MESSAGE_TYPE,
	type BashBackgroundSettleData,
} from "../../shared/bash-background-settle.js"
import { bashToolDescription } from "../bash-tool-guard.js"
import { readE2eSeam } from "../e2e-seam.js"
import { createBackgroundBashToolDefinition } from "./bash-background-tool.js"
import { BASH_CONTROL_TOOL_NAME } from "./bash-control-tool.js"
import { CommandsPanel } from "./commands-panel.js"
import { createProcessRegistry, DEFAULT_BASH_PROCESS_LIMIT_SECONDS } from "./process-registry.js"
import { createReviewCoordinator } from "./review-coordinator.js"
import { bashSessionKindFromContext } from "./session-policy.js"
import { getSessionState, setSessionState } from "./session-registry.js"
import { createTerminalDelivery } from "./terminal-delivery.js"
import { findUnsettledHandoffs } from "./unsettled-handoffs.js"

/**
 * Handoff override for e2e rigs (KIMCHI_E2E_BASH_HANDOFF_SECONDS), honored
 * inside test harnesses only: e2e scenarios script short commands that must
 * hand off quickly. Production always uses INITIAL_HANDOFF_SECONDS.
 */
function e2eHandoffSeconds(): number | undefined {
	const seam = readE2eSeam("KIMCHI_E2E_BASH_HANDOFF_SECONDS")
	const parsed = seam === undefined || seam.trim() === "" ? Number.NaN : Number(seam)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Create a background-bash extension. Registers the background `bash` tool
 * on `session_start` (carrying the bash-tool-guard steering description so
 * the two compose) and tears down the cohort on `session_shutdown`.
 */
export function bashBackgroundExtension(pi: ExtensionAPI): void {
	let panel: CommandsPanel | undefined
	pi.registerCommand("processes", {
		description: "Inspect this session's managed Bash commands and live output",
		async handler(_args, ctx) {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Command inspection is available in the terminal UI.", "info")
				return
			}
			panel?.close()
			let openedPanel: CommandsPanel | undefined
			try {
				await ctx.ui.custom<void>((tui, theme, _keys, done) => {
					openedPanel = new CommandsPanel(
						getSessionState(ctx.sessionManager.getSessionId())?.registry,
						tui,
						() => done(),
						theme,
					)
					panel = openedPanel
					return openedPanel
				})
			} finally {
				openedPanel?.dispose()
				if (panel === openedPanel) panel = undefined
			}
		},
	})
	pi.on("session_start", (_event: SessionStartEvent, sessionCtx) => {
		panel?.close()
		panel = undefined
		// Reconcile unsettled handoffs BEFORE installing fresh state: a
		// harness that died mid-run left handoffs with no recorded exit, and
		// replay/hydration would restore those rows as running forever.
		// Settle each as failed through the same transcript record the live
		// settle uses — transcript-only, no wire emission on this path (the
		// client rendering the reload is where the flip becomes visible).
		// Handles the PREVIOUS live state still tracks are skipped: a
		// session_start on an already-active session (reload, /resume of the
		// current session) must not settle processes that are actually fine.
		const sessionId = sessionCtx.sessionManager.getSessionId()
		const priorState = getSessionState(sessionId)
		for (const call of findUnsettledHandoffs(sessionCtx.sessionManager.getEntries())) {
			if (priorState?.registry.getEntry(call.handle) !== undefined) continue
			const settle: BashBackgroundSettleData = {
				toolCallId: call.toolCallId,
				isError: true,
				text: "",
				details: { handle: call.handle, exited: false, exitCode: null, reason: "harness restarted" },
			}
			pi.appendEntry(BASH_BACKGROUND_SETTLE_MESSAGE_TYPE, settle)
		}
		// Fresh state per session so handles from a previous session can't
		// be reused, and so a resumed/forked session gets a clean process
		// table and lifecycle coordination (per-command handoffs + bounded
		// waits — no recurring clock).
		const registry = createProcessRegistry()
		const limitSeconds = resolveBashProcessLimitSeconds() ?? DEFAULT_BASH_PROCESS_LIMIT_SECONDS
		const coordinator = createReviewCoordinator({ registry, handoffSeconds: e2eHandoffSeconds() })
		const delivery = createTerminalDelivery()
		// Resolved once per session and stored as required state so the
		// control tool (wait release) and the completion guard share it.
		const sessionKind = bashSessionKindFromContext(sessionCtx)
		const state = { registry, coordinator, delivery, limitSeconds, sessionKind, cwd: sessionCtx.cwd }
		setSessionState(sessionId, state)

		// Footer indicator: publish the running-command count while any run,
		// cleared at zero (the footer hides the segment then). Reset first so a
		// previous session's count never lingers.
		sessionCtx.ui.setStatus(SHELLS_STATUS_KEY, undefined)
		registry.onRunningCountChange((count) => {
			sessionCtx.ui.setStatus(SHELLS_STATUS_KEY, count > 0 ? String(count) : undefined)
		})

		// Re-register `bash` with the background execution definition.
		// The description is the bash-tool-guard steering text so the
		// tool-selection preference still reaches the system prompt even
		// though our registration wins the tool-name slot.
		const tool = createBackgroundBashToolDefinition(sessionCtx.cwd, {
			state,
			// Live availability of the companion tool: a session whose tool set
			// drops bash_control (an allowlist the CLI coupling could not extend,
			// an explicit --exclude-tools, or a plan-mode tool-profile snapshot)
			// must never background a command the model cannot disposition —
			// those executions fall back to plain blocking bash with a
			// deterministic timeout. Re-checked on every bash call.
			controlToolAvailable: () => pi.getActiveTools().includes(BASH_CONTROL_TOOL_NAME),
		})
		const toolWithSteering = {
			...tool,
			description: bashToolDescription(),
			// The promptSnippet is the one-line "Execute bash commands..."
			// summary used in the Available tools section. Keep the
			// upstream/wrapped snippet so the system prompt still lists bash.
			promptSnippet: tool.promptSnippet,
		}
		pi.registerTool(toolWithSteering)
	})

	pi.on("session_shutdown", async (_event: SessionShutdownEvent, ctx) => {
		panel?.close()
		panel = undefined
		const sessionId = ctx.sessionManager.getSessionId()
		const state = getSessionState(sessionId)
		if (state) {
			// Unpublish BEFORE draining: shutdown() kills pending processes,
			// which settles their whenExited promises — and a still-published
			// registry would let bashControlExtension's exit watcher emit an
			// "exited on its own" notice into the closing session.
			setSessionState(sessionId, undefined)
			state.coordinator.dispose()
			await state.registry.shutdown()
		}
	})
}

export default bashBackgroundExtension
