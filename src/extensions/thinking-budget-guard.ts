import type { ExtensionAPI, InputEvent, TurnEndEvent } from "@earendil-works/pi-coding-agent"

/**
 * Thinking budget guard.
 *
 * Steers the agent out of two token-wasting deliberation shapes observed in
 * terminal-bench trajectories (see .kimchi/docs/token-analysis):
 *
 *   1. Talk-only mega-think turns — a single assistant turn whose entire
 *      output budget is consumed by reasoning and which ends without a single
 *      tool call. Two post-hoc triggers:
 *        a. `stopReason === "length"` with zero tool-call blocks (the output
 *           cap cut the thinking off mid-deliberation), or
 *        b. thinking characters exceed the per-turn budget
 *           (~20K tokens ≈ 80K chars, p90-calibrated from the token-analysis
 *           baseline: talk-only turns average 14.6K chars; the pathological
 *           tail starts at ≥66K) — again with zero tool calls.
 *      Both fire at `turn_end`. A mid-stream abort trigger (interrupting the
 *      thinking while it streams) is a deliberate follow-up: it needs a loop
 *      interruption hook and ships behind its own flag.
 *
 *   2. Failure-state grinding — several consecutive rounds each spending real
 *      reasoning effort ({@link DEFAULT_STREAK_MIN_THINKING_CHARS}+ chars)
 *      without a mutating tool call (edit/write/bash). After
 *      {@link DEFAULT_STREAK_THRESHOLD} such rounds the guard steers once:
 *      run the candidate you have. The streak resets on any mutating call
 *      (and on any light-thinking round), and v1 counts any bash call as
 *      action, consistent with the exploration guard's rationale that bash is
 *      execution as often as inspection.
 *
 * Steer, never terminate (loop-guard warn precedent): the guard only injects
 * steering messages; a misjudged hard task can still recover.
 */
export type ThinkingBudgetTrigger = "length_truncation" | "thinking_overrun" | "think_only_streak"

export interface ThinkingBudgetSteer {
	trigger: ThinkingBudgetTrigger
	text: string
}

export interface ThinkingBudgetGuardOptions {
	/** Per-turn thinking budget in characters (~4 chars/token). Default: {@link DEFAULT_THINKING_BUDGET_CHARS}. */
	thinkingBudgetChars?: number
	/** Minimum thinking chars for a round to count toward the no-action streak. Default: {@link DEFAULT_STREAK_MIN_THINKING_CHARS}. */
	streakMinThinkingChars?: number
	/** Consecutive heavy-think no-mutation rounds before the streak steer fires. Default: {@link DEFAULT_STREAK_THRESHOLD}. */
	streakThreshold?: number
	/** Tool names that count as mutating action. Default: edit/write/bash. */
	mutatingTools?: ReadonlySet<string>
}

export const DEFAULT_THINKING_BUDGET_CHARS = 80_000
export const DEFAULT_STREAK_MIN_THINKING_CHARS = 5_000
export const DEFAULT_STREAK_THRESHOLD = 3
export const DEFAULT_MUTATING_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "bash"])

export const STEER_MESSAGE_TYPE = "thinking-budget-guard-steer"

const LENGTH_TRUNCATION_STEER =
	"Thinking budget guard: your last response hit the output token limit while still reasoning and never reached a tool call. " +
	"Stop deliberating: act on the plan you already have and emit your single best tool call now, even if your analysis is incomplete. " +
	"A concrete attempt produces information; unbounded thinking only burns the output budget."

const THINK_OVERRUN_STEER_BASE =
	"Thinking budget guard: this turn spent %d characters reasoning without making a single tool call. " +
	"Stop deliberating and act on what you already have — emit your best tool call now, even if your analysis is incomplete."

const THINK_ONLY_STREAK_STEER =
	"Thinking budget guard: %d consecutive rounds of heavy reasoning with no mutating action. " +
	"Stop reasoning. Run the candidate you have, even if it might be wrong — failure output is information."

export class ThinkingBudgetGuard {
	private readonly thinkingBudgetChars: number
	private readonly streakMinThinkingChars: number
	private readonly streakThreshold: number
	private readonly mutatingTools: ReadonlySet<string>

	private thinkOnlyStreak = 0

	constructor(options: ThinkingBudgetGuardOptions = {}) {
		this.thinkingBudgetChars = options.thinkingBudgetChars ?? DEFAULT_THINKING_BUDGET_CHARS
		this.streakMinThinkingChars = options.streakMinThinkingChars ?? DEFAULT_STREAK_MIN_THINKING_CHARS
		this.streakThreshold = options.streakThreshold ?? DEFAULT_STREAK_THRESHOLD
		this.mutatingTools = options.mutatingTools ?? DEFAULT_MUTATING_TOOLS
	}

	reset(): void {
		this.thinkOnlyStreak = 0
	}

	getConsecutiveThinkOnlyRounds(): number {
		return this.thinkOnlyStreak
	}

	/**
	 * Observe one completed turn (round). Returns a steering payload when a
	 * trigger fires, undefined otherwise. At most one steer is returned per
	 * turn: the truncation/overrun triggers take precedence over the streak
	 * steer and reset the streak, so a pathological stretch produces a single
	 * intervention per turn instead of stacking messages.
	 */
	observeTurn(message: TurnEndEvent["message"]): ThinkingBudgetSteer | undefined {
		// Safe after the role guard: AgentMessage with role "assistant" is AssistantMessage.
		if (message.role !== "assistant") return undefined
		// Errors and user aborts are not deliberation failures — the model
		// never got to finish the turn (exploration-guard precedent).
		if (message.stopReason === "error" || message.stopReason === "aborted") return undefined

		let thinkingChars = 0
		let toolCalls = 0
		let hasMutatingToolCall = false
		for (const block of message.content) {
			if (block.type === "thinking") {
				thinkingChars += block.thinking.length
			} else if (block.type === "toolCall") {
				toolCalls++
				if (this.mutatingTools.has(block.name)) hasMutatingToolCall = true
			}
		}

		if (hasMutatingToolCall) {
			this.thinkOnlyStreak = 0
		} else if (thinkingChars > this.streakMinThinkingChars) {
			this.thinkOnlyStreak++
		} else {
			this.thinkOnlyStreak = 0
		}

		if (toolCalls === 0 && message.stopReason === "length") {
			this.thinkOnlyStreak = 0
			return { trigger: "length_truncation", text: LENGTH_TRUNCATION_STEER }
		}

		if (toolCalls === 0 && thinkingChars > this.thinkingBudgetChars) {
			this.thinkOnlyStreak = 0
			return {
				trigger: "thinking_overrun",
				text: THINK_OVERRUN_STEER_BASE.replace("%d", String(thinkingChars)),
			}
		}

		if (hasMutatingToolCall) return undefined

		if (this.thinkOnlyStreak >= this.streakThreshold) {
			this.thinkOnlyStreak = 0
			return {
				trigger: "think_only_streak",
				text: THINK_ONLY_STREAK_STEER.replace("%d", String(this.streakThreshold)),
			}
		}

		return undefined
	}
}

export default function thinkingBudgetGuardExtension(pi: ExtensionAPI): void {
	const guard = new ThinkingBudgetGuard()

	pi.on("session_start", () => {
		guard.reset()
	})

	pi.on("input", (event: InputEvent) => {
		// Fresh user input starts a new behavioural window.
		if (event.source === "extension") return
		guard.reset()
	})

	pi.on("turn_end", (event) => {
		const steer = guard.observeTurn(event.message)
		if (!steer) return
		pi.sendMessage(
			{
				customType: STEER_MESSAGE_TYPE,
				content: [{ type: "text", text: steer.text }],
				display: false,
			},
			{ deliverAs: "steer" },
		)
	})
}
