import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "./agent-worker-context.js"
import { getPermissionMode } from "./permissions/mode-controller.js"

export const DEFAULT_READ_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"web_search",
	"web_fetch",
	"lsp_hover",
	"lsp_definition",
	"lsp_references",
	"lsp_diagnostics",
	// bash is intentionally excluded from the default read set. It is used for
	// execution (tests, git ops, builds) as often as for inspection (git diff,
	// git log, grep). The false positives it caused on work turns outweigh the
	// missed detections. Callers who want bash to count can pass a custom
	// readTools set that includes it.
	"mcp",
])

export const DEFAULT_WRITE_TOOLS = new Set(["edit", "write", "lsp_rename", "ask_user", "steer_subagent", "Agent"])

export const DEFAULT_NEUTRAL_TOOLS = new Set(["set_phase", "set_model"])

export interface ExplorationGuardOptions {
	/** Tools that count as read-only (default: common inspection tools). */
	readTools?: Set<string>
	/** Tools that count as write operations (default: common mutating tools). */
	writeTools?: Set<string>
	/** Number of consecutive read-only turns before a reminder is injected. Default: 5 */
	hypothesisThreshold?: number
	/** Number of consecutive read-only turns before a mandatory steer is injected. Default: 8 */
	steerThreshold?: number
	/** Number of consecutive no-tool turns before a warning steer. Default: 3 */
	noToolWarnThreshold?: number
	/** Number of consecutive no-tool turns before a mandatory steer. Default: 5 */
	noToolSteerThreshold?: number
	/** Optional predicate to temporarily disable the guard (e.g., during plan mode). */
	isEnabled?: () => boolean
	/** Predicate evaluated at event time to determine whether the agent
	 *  is a subagent. Subagents terminate (block tool calls) after the
	 *  no-tool mandatory threshold; main agents keep steer-only behaviour.
	 *  Called per-event so AsyncLocalStorage context is respected.
	 *  Default: always false. */
	isSubagent?: () => boolean
}

const HYPOTHESIS_REMINDER_BASE =
	"Exploration guard: %d consecutive read-only turns. If you have a clear hypothesis, test it with one targeted command. If you are building context before writing or planning, consider whether you have enough — and if so, take the next concrete action."

const MANDATORY_STEER_BASE =
	"Exploration guard: %d consecutive read-only turns. You must take a concrete action this turn: run a targeted test, make an edit, write a plan, or ask the user a question. Do not read further without a clear reason."

const NO_TOOL_WARNING_BASE =
	"Exploration guard: %d consecutive turns with no tool calls. Take action: write code, run a command, or ask the user. Reasoning without acting does not make progress."

const NO_TOOL_MANDATORY_BASE =
	"Exploration guard: %d consecutive turns with no tool calls. You must use a tool this turn. Summarize your plan and take one concrete action."

/** Stronger message for the mandatory steer — used both for subagents (where
 *  the next tool call will be blocked) and for main agents (where the
 *  previous wording was being ignored indefinitely on stuck tasks). */
/**
 * Steer sent to a stuck subagent before the abort fires.
 * The subagent gets ONE more turn to produce a text response;
 * that response is what the orchestrator will see as the subagent's output.
 * Be explicit about what a useful summary contains.
 */
const NO_TOOL_SUBAGENT_ABORT_STEER =
	"Exploration guard: this subagent has produced %d consecutive turns with no tool calls and will be terminated after this turn. " +
	"Respond NOW with a plain-text summary covering: (1) what you were asked to do, " +
	"(2) what you completed or changed, (3) what is still incomplete and why, " +
	"(4) any key findings or blockers. Do not call any tools. This summary is the only output the orchestrator will receive."

export const STEER_MESSAGE_TYPE = "exploration-guard-steer"

export class ExplorationGuard {
	private readonly readTools: Set<string>
	private readonly writeTools: Set<string>
	private readonly hypothesisThreshold: number
	private readonly steerThreshold: number
	private readonly noToolWarnThreshold: number
	private readonly noToolSteerThreshold: number
	private readonly isEnabled: () => boolean
	private readonly isSubagent: () => boolean

	private consecutiveReadOnlyTurns = 0
	private consecutiveNoToolTurns = 0
	private currentTurnHasWriteTool = false
	private currentTurnHasAnyTool = false
	private currentTurnHasReadTool = false
	/** When true (subagent only), the guard will call pi.abort() on the next
	 *  turn_end. Set after the abort-steer fires; the subagent gets exactly
	 *  one more turn to produce a text summary. Cleared on reset(). */
	private subagentAbortPending = false

	constructor(options: ExplorationGuardOptions = {}) {
		this.readTools = options.readTools ?? new Set(DEFAULT_READ_TOOLS)
		this.writeTools = options.writeTools ?? new Set(DEFAULT_WRITE_TOOLS)
		this.hypothesisThreshold = options.hypothesisThreshold ?? 5
		this.steerThreshold = options.steerThreshold ?? 8
		this.noToolWarnThreshold = options.noToolWarnThreshold ?? 3
		this.noToolSteerThreshold = options.noToolSteerThreshold ?? 5
		this.isEnabled = options.isEnabled ?? (() => true)
		this.isSubagent = options.isSubagent ?? (() => false)
	}

	reset(): void {
		this.consecutiveReadOnlyTurns = 0
		this.consecutiveNoToolTurns = 0
		this.currentTurnHasWriteTool = false
		this.currentTurnHasAnyTool = false
		this.currentTurnHasReadTool = false
		this.subagentAbortPending = false
	}

	turnStart(): void {
		this.currentTurnHasWriteTool = false
		this.currentTurnHasAnyTool = false
		this.currentTurnHasReadTool = false
	}

	recordToolCall(toolName: string): void {
		this.currentTurnHasAnyTool = true
		if (this.writeTools.has(toolName)) {
			this.currentTurnHasWriteTool = true
		}
		if (this.readTools.has(toolName)) {
			this.currentTurnHasReadTool = true
		}
	}

	turnEnd(sendSteer: (text: string) => void): void {
		if (!this.isEnabled()) {
			// Reset both streaks while the guard is suppressed so they don't
			// fire immediately when it becomes re-enabled (e.g. after scoping).
			this.consecutiveReadOnlyTurns = 0
			this.consecutiveNoToolTurns = 0
			return
		}

		// No-tool turn: the model produced a response without calling any tools.
		// Track separately from the read-only streak. Do NOT reset
		// consecutiveReadOnlyTurns — a no-tool turn is neutral for that counter
		// and resetting it would hide long exploration stretches broken up by
		// occasional reasoning-only turns (which the thinking-only detector
		// would then miss).
		if (!this.currentTurnHasAnyTool) {
			this.consecutiveNoToolTurns++

			if (this.consecutiveNoToolTurns === this.noToolSteerThreshold) {
				// Subagents: send a summary-request steer and schedule an abort on
				// the next turn_end. The subagent gets one turn to produce a useful
				// text summary; that text becomes the output the orchestrator sees.
				// Main agents: original wording — stronger messages caused models
				// to think harder instead of acting.
				if (this.isSubagent()) {
					sendSteer(NO_TOOL_SUBAGENT_ABORT_STEER.replace("%d", String(this.noToolSteerThreshold)))
					this.subagentAbortPending = true
				} else {
					sendSteer(NO_TOOL_MANDATORY_BASE.replace("%d", String(this.noToolSteerThreshold)))
				}
				// Reset the counter after the mandatory steer.
				this.consecutiveNoToolTurns = 0
			} else if (this.consecutiveNoToolTurns === this.noToolWarnThreshold) {
				sendSteer(NO_TOOL_WARNING_BASE.replace("%d", String(this.noToolWarnThreshold)))
				// Don't reset yet — the model gets a chance to course-correct
				// before the mandatory steer fires at noToolSteerThreshold.
			}
			return
		}

		// A turn with at least one tool call resets the no-tool counter.
		this.consecutiveNoToolTurns = 0

		// A turn is read-only only if it contains at least one read tool and none
		// of them are write tools. Turns with write tools or with only neutral
		// tools reset the streak.
		if (this.currentTurnHasWriteTool || !this.currentTurnHasReadTool) {
			this.consecutiveReadOnlyTurns = 0
			return
		}

		this.consecutiveReadOnlyTurns++

		if (this.consecutiveReadOnlyTurns === this.hypothesisThreshold) {
			sendSteer(HYPOTHESIS_REMINDER_BASE.replace("%d", String(this.hypothesisThreshold)))
			// Don't reset yet — the model gets a chance to course-correct before
			// the mandatory steer fires at steerThreshold.
		}
		if (this.consecutiveReadOnlyTurns === this.steerThreshold) {
			sendSteer(MANDATORY_STEER_BASE.replace("%d", String(this.steerThreshold)))
			// Reset after the mandatory steer so the model gets a fresh budget
			// rather than immediately re-triggering on the next read turn.
			this.consecutiveReadOnlyTurns = 0
		}
	}

	getConsecutiveReadOnlyTurns(): number {
		return this.consecutiveReadOnlyTurns
	}

	getConsecutiveNoToolTurns(): number {
		return this.consecutiveNoToolTurns
	}

	/** True when the guard has scheduled an abort for the next turn_end.
	 *  Only set for subagents after the no-tool mandatory threshold fires.
	 *  Always false for main agents. Cleared on reset(). */
	isSubagentAbortPending(): boolean {
		return this.subagentAbortPending
	}
}

export default function explorationGuardExtension(pi: ExtensionAPI, options?: ExplorationGuardOptions): void {
	// ExtensionContext is populated on session start
	let ctx: ExtensionContext | undefined

	const guard = new ExplorationGuard({
		...options,
		// Disabled during plan-permission mode (e.g. ferment build phase) and
		// during active ferment scoping — both contexts mandate deep exploration.
		isEnabled: () => {
			const sessionId = ctx?.sessionManager.getSessionId()
			if (!sessionId) return false
			if (getPermissionMode(sessionId)?.mode === "plan") return false
			try {
				// Avoid a hard import cycle: ferment state is optional.
				// eslint-disable-next-line @typescript-eslint/no-require-imports
				const s: typeof import("./ferment/state.js") = require("./ferment/state.js")
				const { isScopingInteractive, getActiveFermentId } = s
				const fermentId = getActiveFermentId()
				if (fermentId && isScopingInteractive(fermentId)) return false
				// Keep guard active during ferment execution phases — scoping is done.
			} catch {
				// ferment state module unavailable — ignore
			}
			return true
		},
		// Subagent terminate: call isAgentWorker() per-event so the
		// AsyncLocalStorage context is respected (each tool call / turn
		// end fires inside the worker context when a subagent is active).
		// The caller can override via `options.isSubagent`.
		isSubagent: options?.isSubagent ?? (() => isAgentWorker()),
	})

	pi.on("session_start", (_event, _ctx) => {
		ctx = _ctx
		guard.reset()
	})

	pi.on("input", (event: InputEvent) => {
		// User input breaks the exploration streak.
		if (event.source === "extension") return
		// The reset() call clears subagentStuck as well, so a fresh user
		// prompt un-sticks the subagent even if the previous turn was blocked.
		guard.reset()
	})

	pi.on("turn_start", () => {
		guard.turnStart()
	})

	pi.on("tool_call", (event) => {
		if (!event.toolName) return
		guard.recordToolCall(event.toolName)
		return { block: false }
	})

	pi.on("turn_end", () => {
		// If a subagent abort is pending, fire it NOW before processing the
		// steer. The subagent already received the summary-request steer last
		// turn; whatever it produced this turn becomes the orchestrator output.
		if (guard.isSubagentAbortPending()) {
			ctx?.abort()
			return
		}

		guard.turnEnd((text) => {
			pi.sendMessage(
				{
					customType: STEER_MESSAGE_TYPE,
					content: [{ type: "text", text }],
					display: false,
				},
				{ deliverAs: "steer" },
			)
		})
	})
}
