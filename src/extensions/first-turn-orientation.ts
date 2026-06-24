/**
 * First-turn orientation enforcement.
 *
 * The orchestrator prompt instructs the model to orient the user (state intent
 * + why) before long-running tool sequences. Empirically, models — especially
 * with thinking blocks enabled — sometimes satisfy that instruction by writing
 * the orientation only inside the thinking block, leaving the user with no
 * visible signal that work has started. Three rounds of prompt-strengthening
 * produced inconsistent results (1 of 3 benchmark runs emitted visible text).
 *
 * This extension closes the gap with a soft, harness-level enforcement:
 * on the first turn of a session, the first `tool_call` that arrives without
 * any prior visible `text_delta` is blocked once with a reason. The model
 * sees the reason and retries; if it emits text, the rest of the turn
 * proceeds normally. If it cannot produce text, the existing `loop-guard`
 * is the safety net.
 *
 * Design notes:
 * - Only fires on turnIndex === 0 (no noise on subsequent turns).
 * - Block-once-per-turn semantics: after the first block in a turn,
 *   subsequent tool calls are allowed through. Aggressive multi-block
 *   enforcement risks weird retry behaviour; the loop-guard covers
 *   the "model genuinely cannot produce text" case.
 * - Subagent mode is naturally compatible: subagents emit JSON text,
 *   which counts as visible text and clears the gate.
 * - Does NOT modify the message itself — only blocks tool calls.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export const ORIENTATION_BLOCK_MESSAGE =
	"Your first response to a complex task must include a brief visible text message orienting the user (what you intend to do and why) before any tool call. Thinking alone is not enough — emit visible text first, then call tools."

export interface FirstTurnOrientationDecision {
	/** Whether the tool call should be blocked. */
	block: boolean
	/** Reason to send back if blocking. */
	reason?: string
}

export class FirstTurnOrientationGuard {
	private visibleTextSeenThisTurn = false
	private blockedThisTurn = false
	private isFirstTurn = true

	/**
	 * Reset per-turn state. Called on turn_start so each new turn starts
	 * fresh. After reset, the first tool_call of a first turn (turnIndex 0)
	 * with no visible text will block again — which is the desired
	 * behaviour if the user re-prompts and the model dives straight into
	 * tools on the new turn.
	 */
	reset(): void {
		this.visibleTextSeenThisTurn = false
		this.blockedThisTurn = false
	}

	/**
	 * Reset session-level state. Called on session_start. The first turn
	 * flag is re-armed so a new session also has orientation enforcement.
	 */
	resetSession(): void {
		this.reset()
		this.isFirstTurn = true
	}

	/**
	 * Hook: turn_start. Updates the first-turn flag based on the incoming
	 * turn index, then resets per-turn state.
	 */
	onTurnStart(turnIndex: number): void {
		this.reset()
		this.isFirstTurn = turnIndex === 0
	}

	/**
	 * Hook: message_update with assistantMessageEvent.type === "text_delta".
	 * Marks visible text as seen for the current turn.
	 */
	recordTextDelta(): void {
		this.visibleTextSeenThisTurn = true
	}

	/**
	 * Decide whether to block the current tool call.
	 * Block-once-per-turn: first call on a first turn with no visible text
	 * returns { block: true }; subsequent calls in the same turn return
	 * { block: false } even if text is still missing. The loop-guard is
	 * the safety net for "model genuinely cannot produce text" cases.
	 */
	evaluate(): FirstTurnOrientationDecision {
		if (this.isFirstTurn && !this.visibleTextSeenThisTurn && !this.blockedThisTurn) {
			this.blockedThisTurn = true
			return { block: true, reason: ORIENTATION_BLOCK_MESSAGE }
		}
		return { block: false }
	}

	// Test-only inspection helpers. Not part of the public contract.
	/** @internal */
	_isFirstTurn(): boolean {
		return this.isFirstTurn
	}
	/** @internal */
	_visibleTextSeenThisTurn(): boolean {
		return this.visibleTextSeenThisTurn
	}
	/** @internal */
	_blockedThisTurn(): boolean {
		return this.blockedThisTurn
	}
}

export default function firstTurnOrientationExtension(pi: ExtensionAPI): void {
	const guard = new FirstTurnOrientationGuard()

	pi.on("session_start", () => {
		guard.resetSession()
	})

	pi.on("turn_start", (event) => {
		guard.onTurnStart(event.turnIndex)
	})

	pi.on("message_update", (event) => {
		if (event.assistantMessageEvent?.type === "text_delta") {
			guard.recordTextDelta()
		}
	})

	pi.on("tool_call", (event) => {
		// Pass through empty tool names — let other handlers (e.g. loop-guard)
		// decide what to do.
		if (!event.toolName) return
		const decision = guard.evaluate()
		if (decision.block) {
			return { block: true, reason: decision.reason ?? ORIENTATION_BLOCK_MESSAGE }
		}
	})
}
