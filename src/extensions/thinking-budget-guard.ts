import type { ExtensionAPI, InputEvent, TurnEndEvent } from "@earendil-works/pi-coding-agent"

/**
 * Thinking budget guard.
 *
 * Steers the agent out of two token-wasting deliberation shapes observed in
 * terminal-bench trajectories:
 *
 *   1. Talk-only mega-think turns — a single assistant turn whose entire
 *      output budget is consumed by reasoning and which ends without a single
 *      tool call. Two post-hoc triggers:
 *        a. `stopReason === "length"` with zero tool-call blocks (the output
 *           cap cut the thinking off mid-deliberation), or
 *        b. thinking characters exceed the per-turn budget
 *           ({@link DEFAULT_THINKING_BUDGET_CHARS} chars) — again with zero
 *           tool calls.
 *      Both fire at `turn_end`. A third, mid-stream variant (trigger B)
 *      aborts the provider request while the thinking is still streaming.
 *      It is active by default in headless sessions and never wired in
 *      interactive/TUI contexts (ctx.abort() is a no-op there);
 *      `KIMCHI_THINKING_PREEMPT=0` (or false/no) disables it, and the
 *      budget can be overridden via `KIMCHI_THINKING_BUDGET_CHARS` — see
 *      `registerPreempt` below.
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

/**
 * Env flag for the mid-stream preempt (trigger B). On by default in
 * headless sessions; set to 0/false/no to disable.
 */
export const KIMCHI_THINKING_PREEMPT_ENV = "KIMCHI_THINKING_PREEMPT"
/** One-shot calibration override for the per-turn thinking budget, in chars. */
export const KIMCHI_THINKING_BUDGET_CHARS_ENV = "KIMCHI_THINKING_BUDGET_CHARS"

/**
 * Default-on: only an explicit falsy value ("0"/"false"/"no", trimmed and
 * case-insensitive) disables the preempt — the A/B kill switch. Unset,
 * empty, or any other value leaves it enabled.
 */
export function isThinkingPreemptEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env[KIMCHI_THINKING_PREEMPT_ENV]?.trim().toLowerCase()
	return raw !== "0" && raw !== "false" && raw !== "no"
}

export function resolveThinkingBudgetChars(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[KIMCHI_THINKING_BUDGET_CHARS_ENV]?.trim()
	if (!raw) return DEFAULT_THINKING_BUDGET_CHARS
	const parsed = Number.parseInt(raw, 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_THINKING_BUDGET_CHARS
}

const PREEMPT_STEER_BASE =
	"Thinking budget guard: your reasoning was cut off at %d characters because it showed no sign of reaching a tool call. " +
	"Stop deliberating and act on what you already have — emit your best tool call now, even if your analysis is incomplete."

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
	const guard = new ThinkingBudgetGuard({ thinkingBudgetChars: resolveThinkingBudgetChars() })

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

	registerPreempt(pi)
}

/**
 * Trigger B: mid-stream preempt. On by default in headless sessions;
 * `KIMCHI_THINKING_PREEMPT=0` (or false/no) opts out.
 *
 * Watches the streaming partial message and aborts the provider request as
 * soon as accumulated thinking crosses the per-turn budget while no tool
 * call has started — the talk-only mega-think shape caught mid-bleed instead
 * of at turn_end. The abort ends the run; the steer is then queued from
 * `agent_end` with `deliverAs: "steer"` so the session's post-run
 * continuation (`_handlePostAgentRun` → `agent.continue()`) feeds it to the
 * model inside the same prompt await. The aborted turn lands with
 * `stopReason: "aborted"`, which `observeTurn` already skips — no double
 * steer from the post-hoc triggers.
 *
 * Not wired in TUI contexts: interactive mode rebinds ctx.abort() to an
 * editor-restore no-op, so the abort would never fire and the steer would
 * dangle. The post-hoc turn_end trigger covers interactive sessions.
 */
function registerPreempt(pi: ExtensionAPI): void {
	if (!isThinkingPreemptEnabled()) return

	const budgetChars = resolveThinkingBudgetChars()
	let isTui = false
	let thinkingChars = 0
	let sawToolCall = false
	let latched = false
	let pendingSteer = false

	function resetTurn(): void {
		thinkingChars = 0
		sawToolCall = false
		latched = false
	}

	pi.on("session_start", (_event, ctx) => {
		isTui = ctx.mode === "tui"
		pendingSteer = false
		resetTurn()
	})

	pi.on("input", (event: InputEvent) => {
		if (event.source === "extension") return
		pendingSteer = false
		resetTurn()
	})

	pi.on("turn_start", () => {
		resetTurn()
	})

	pi.on("message_update", (event, ctx) => {
		// Runs on every delta — keep it to a cheap accumulation + compare.
		if (isTui || latched || pendingSteer || sawToolCall) return
		const message = event.message
		if (message.role !== "assistant") return
		for (const block of message.content) {
			if (block.type === "thinking") {
				thinkingChars += block.thinking.length
			} else if (block.type === "toolCall") {
				sawToolCall = true
				return
			}
		}
		if (thinkingChars <= budgetChars) return
		latched = true
		pendingSteer = true
		ctx.abort()
	})

	pi.on("agent_end", () => {
		if (!pendingSteer) return
		pendingSteer = false
		latched = false
		// Queue (not triggerTurn): the session detects messages queued from
		// agent_end handlers and continues the run with this steer as input.
		pi.sendMessage(
			{
				customType: STEER_MESSAGE_TYPE,
				content: [{ type: "text", text: PREEMPT_STEER_BASE.replace("%d", String(thinkingChars)) }],
				display: false,
			},
			{ deliverAs: "steer" },
		)
	})
}
