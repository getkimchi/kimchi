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
	type BackgroundProcessItem,
	backgroundWorkLabel,
	registerBackgroundWorkProvider,
} from "../../shared/background-work.js"
import {
	BASH_BACKGROUND_SETTLE_MESSAGE_TYPE,
	type BashBackgroundSettleData,
} from "../../shared/bash-background-settle.js"
import { bashToolDescription } from "../bash-tool-guard.js"
import { readE2eSeam } from "../e2e-seam.js"
import { createBackgroundBashToolDefinition } from "./bash-background-tool.js"
import { BASH_CONTROL_TOOL_NAME } from "./bash-control-tool.js"
import { USER_STOP_REASON } from "./bash-display.js"
import { CommandsPanel } from "./commands-panel.js"
import {
	createProcessRegistry,
	DEFAULT_BASH_PROCESS_LIMIT_SECONDS,
	type ProcessDisplaySnapshot,
	type ProcessRegistry,
} from "./process-registry.js"
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

function processItem(snapshot: ProcessDisplaySnapshot): BackgroundProcessItem {
	return { kind: "process", id: snapshot.handle, label: backgroundWorkLabel(snapshot.description || snapshot.command) }
}

function runningSnapshots(registry: ProcessRegistry): ProcessDisplaySnapshot[] {
	return registry.listDisplaySnapshots().filter((snapshot) => snapshot.state === "running")
}

/**
 * Create a background-bash extension. Registers the background `bash` tool
 * on `session_start` (carrying the bash-tool-guard steering description so
 * the two compose) and tears down the cohort on `session_shutdown`.
 */
export function bashBackgroundExtension(pi: ExtensionAPI): void {
	let panel: CommandsPanel | undefined
	// Handles seen in any cohort of a session during this process's life.
	// Every session_start installs a fresh registry, so without the set a
	// repeated start could misread an earlier cohort's still-running
	// process as an unsettled handoff; cleared on session_shutdown.
	const liveHandlesBySession = new Map<string, Set<string>>()
	const unregisterBackgroundWorkBySession = new Map<string, () => void>()
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
		// harness that died mid-run left handoffs with no recorded exit, so
		// settle each as failed through the same transcript record the live
		// settle uses. Handles still running under this session are skipped
		// (they are tracked across restarts below): a repeated session_start
		// of an already-active session must not false-settle a live process
		// the registry installed by an earlier restart never saw spawn.
		const sessionId = sessionCtx.sessionManager.getSessionId()
		const priorState = getSessionState(sessionId)
		const liveHandles = liveHandlesBySession.get(sessionId) ?? new Set<string>()
		if (priorState) {
			for (const handle of priorState.registry.handles()) liveHandles.add(handle)
			liveHandlesBySession.set(sessionId, liveHandles)
		}
		for (const call of findUnsettledHandoffs(sessionCtx.sessionManager.getEntries())) {
			if (liveHandles.has(call.handle)) continue
			const settle: BashBackgroundSettleData = {
				toolCallId: call.toolCallId,
				isError: true,
				text: "",
				// Terminal isError over exited: false is the contradiction
				// normalizeUnheldHandoffResult strips on replay, so record the
				// process as exited; the LOSS signal lives in exitCode: null +
				// "harness restarted", not in liveness markers.
				details: { handle: call.handle, exited: true, exitCode: null, reason: "harness restarted" },
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
		unregisterBackgroundWorkBySession.get(sessionId)?.()
		unregisterBackgroundWorkBySession.set(
			sessionId,
			registerBackgroundWorkProvider(sessionId, "bash", {
				list: () => runningSnapshots(registry).map(processItem),
				stopAll: async () => {
					const running = runningSnapshots(registry)
					await Promise.all(running.map((snapshot) => registry.kill(snapshot.handle, USER_STOP_REASON)))
					return running.map(processItem)
				},
			}),
		)

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
		// Same point as the unpublish below: a user stop must not reach a
		// registry that is being drained.
		unregisterBackgroundWorkBySession.get(sessionId)?.()
		unregisterBackgroundWorkBySession.delete(sessionId)
		const state = getSessionState(sessionId)
		if (state) {
			// Unpublish BEFORE draining: shutdown() kills pending processes,
			// which settles their whenExited promises — and a still-published
			// registry would let bashControlExtension's exit watcher emit an
			// "exited on its own" notice into the closing session.
			setSessionState(sessionId, undefined)
			liveHandlesBySession.delete(sessionId)
			state.coordinator.dispose()
			await state.registry.shutdown()
		}
	})
}

export default bashBackgroundExtension
