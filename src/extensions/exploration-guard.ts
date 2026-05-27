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
	"bash",
	"mcp",
])

export const DEFAULT_WRITE_TOOLS = new Set(["edit", "write", "lsp_rename", "ask_user", "steer_subagent", "Agent"])

export interface ExplorationGuardOptions {
	/** Tools that count as read-only (default: common inspection tools). */
	readTools?: Set<string>
	/** Tools that count as write operations (default: common mutating tools). */
	writeTools?: Set<string>
	/** Number of consecutive read-only turns before a reminder is injected. Default: 5 */
	hypothesisThreshold?: number
	/** Number of consecutive read-only turns before a mandatory steer is injected. Default: 8 */
	steerThreshold?: number
}

const HYPOTHESIS_REMINDER_BASE =
	"Exploration guard: you have spent %d consecutive turns reading without formulating a concrete hypothesis. State your hypothesis and run ONE targeted command to test it. Reading without a hypothesis wastes tokens."

const MANDATORY_STEER_BASE =
	"Exploration guard: you have spent %d consecutive turns in read-only exploration. You MUST either (1) state a concrete hypothesis and test it with a single targeted command, or (2) transition to the plan phase. Do not continue reading without a hypothesis."

export const STEER_MESSAGE_TYPE = "exploration-guard-steer"

export class ExplorationGuard {
	private readonly readTools: Set<string>
	private readonly writeTools: Set<string>
	private readonly hypothesisThreshold: number
	private readonly steerThreshold: number

	private consecutiveReadOnlyTurns = 0
	private currentTurnHasWriteTool = false
	private currentTurnHasAnyTool = false

	constructor(options: ExplorationGuardOptions = {}) {
		this.readTools = options.readTools ?? new Set(DEFAULT_READ_TOOLS)
		this.writeTools = options.writeTools ?? new Set(DEFAULT_WRITE_TOOLS)
		this.hypothesisThreshold = options.hypothesisThreshold ?? 5
		this.steerThreshold = options.steerThreshold ?? 8
	}

	reset(): void {
		this.consecutiveReadOnlyTurns = 0
		this.currentTurnHasWriteTool = false
		this.currentTurnHasAnyTool = false
	}

	turnStart(): void {
		this.currentTurnHasWriteTool = false
		this.currentTurnHasAnyTool = false
	}

	recordToolCall(toolName: string): void {
		this.currentTurnHasAnyTool = true
		if (this.writeTools.has(toolName)) {
			this.currentTurnHasWriteTool = true
		}
	}

	turnEnd(sendSteer: (text: string) => void): void {
		// A turn is read-only only if it contains at least one tool and none
		// of them are write tools. Turns with no tools or with write tools
		// reset the streak.
		if (!this.currentTurnHasAnyTool || this.currentTurnHasWriteTool) {
			this.consecutiveReadOnlyTurns = 0
			return
		}

		this.consecutiveReadOnlyTurns++

		if (this.consecutiveReadOnlyTurns === this.hypothesisThreshold) {
			sendSteer(HYPOTHESIS_REMINDER_BASE.replace("%d", String(this.hypothesisThreshold)))
		}
		if (this.consecutiveReadOnlyTurns === this.steerThreshold) {
			sendSteer(MANDATORY_STEER_BASE.replace("%d", String(this.steerThreshold)))
		}
	}

	getConsecutiveReadOnlyTurns(): number {
		return this.consecutiveReadOnlyTurns
	}
}

export default function explorationGuardExtension(pi: ExtensionAPI, options?: ExplorationGuardOptions): void {
	const guard = new ExplorationGuard(options)

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
