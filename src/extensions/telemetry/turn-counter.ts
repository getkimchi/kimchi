/**
 * Kimchi's session turn counter, shared by telemetry events and the `X-Turn-Index` provider header so both name the
 * same turn.
 */
export class TurnCounter {
	/**
	 * Current turn index: a 1-based, strictly increasing count of LLM turns
	 * (round-trips) in this session — one per turn_start, across all agent
	 * runs (prompts), never reset mid-session. Events are stamped with the
	 * turn they occurred in. `0` occurs only before the session's first turn
	 * (e.g. a warmup provider call); treat it as "pre-turn", not a turn number.
	 */
	turnIndex = 0
	/** Turn slot allocated to the last user_message (see stampUserMessageTurn). */
	private lastUserMessageTurn = 0

	/** Start counting again for a new session. */
	resetTurns(): void {
		this.turnIndex = 0
		this.lastUserMessageTurn = 0
	}

	/**
	 * Advance the session turn counter for a new LLM turn (called on every
	 * turn_start) and return it. Merges with the user-message slot so values
	 * stay strictly increasing even when a prompt failed to start a turn.
	 */
	advanceTurn(): number {
		this.turnIndex = Math.max(this.turnIndex + 1, this.lastUserMessageTurn)
		return this.turnIndex
	}

	/**
	 * Turn slot the run started by this prompt will occupy — stamped on its
	 * user_message record (before_agent_start fires before the first
	 * turn_start). Strictly increasing even when the prompt never starts a
	 * turn (blocked or failed before the agent loop).
	 */
	stampUserMessageTurn(): number {
		this.lastUserMessageTurn = Math.max(this.lastUserMessageTurn + 1, this.turnIndex + 1)
		return this.lastUserMessageTurn
	}
}
