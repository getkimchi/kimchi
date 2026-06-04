import type { ExtensionAPI, InputEvent } from "@earendil-works/pi-coding-agent"

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
	/** Optional predicate to temporarily disable the guard (e.g., during plan mode). */
	isEnabled?: () => boolean
}

const HYPOTHESIS_REMINDER_BASE =
	"Exploration guard: %d consecutive read-only turns. If you have a clear hypothesis, test it with one targeted command. If you are building context before writing or planning, consider whether you have enough — and if so, take the next concrete action."

const MANDATORY_STEER_BASE =
	"Exploration guard: %d consecutive read-only turns. You must take a concrete action this turn: run a targeted test, make an edit, write a plan, or ask the user a question. Do not read further without a clear reason."

export const STEER_MESSAGE_TYPE = "exploration-guard-steer"

export class ExplorationGuard {
	private readonly readTools: Set<string>
	private readonly writeTools: Set<string>
	private readonly hypothesisThreshold: number
	private readonly steerThreshold: number
	private readonly isEnabled: () => boolean

	private consecutiveReadOnlyTurns = 0
	private currentTurnHasWriteTool = false
	private currentTurnHasAnyTool = false
	private currentTurnHasReadTool = false

	constructor(options: ExplorationGuardOptions = {}) {
		this.readTools = options.readTools ?? new Set(DEFAULT_READ_TOOLS)
		this.writeTools = options.writeTools ?? new Set(DEFAULT_WRITE_TOOLS)
		this.hypothesisThreshold = options.hypothesisThreshold ?? 5
		this.steerThreshold = options.steerThreshold ?? 8
		this.isEnabled = options.isEnabled ?? (() => true)
	}

	reset(): void {
		this.consecutiveReadOnlyTurns = 0
		this.currentTurnHasWriteTool = false
		this.currentTurnHasAnyTool = false
		this.currentTurnHasReadTool = false
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
			// Reset the streak while the guard is suppressed so it doesn't
			// fire immediately when it becomes re-enabled (e.g. after scoping).
			this.consecutiveReadOnlyTurns = 0
			return
		}

		// A turn is read-only only if it contains at least one read tool and none
		// of them are write tools. Turns with no tools, with write tools, or with
		// only neutral tools reset the streak.
		if (!this.currentTurnHasAnyTool || this.currentTurnHasWriteTool || !this.currentTurnHasReadTool) {
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
}

export default function explorationGuardExtension(pi: ExtensionAPI, options?: ExplorationGuardOptions): void {
	const guard = new ExplorationGuard({
		...options,
		// Disabled during plan-permission mode (e.g. ferment build phase) and
		// during active ferment scoping — both contexts mandate deep exploration.
		isEnabled: () => {
			if (process.env.KIMCHI_PERMISSIONS === "plan") return false
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
	})

	pi.on("session_start", () => {
		guard.reset()
	})

	pi.on("input", (event: InputEvent) => {
		// User input breaks the exploration streak.
		if (event.source === "extension") return
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
