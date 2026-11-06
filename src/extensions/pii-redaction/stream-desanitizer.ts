/**
 * Streaming token desanitizer — the ACP emission path's substitution layer.
 *
 * ACP streams text as deltas and a token can split across chunk boundaries
 * (`"[EMAIL_ADDRESS_"`/`"1]"`). This class buffers the longest trailing
 * suffix that COULD be an incomplete token and substitutes everything
 * else immediately, so the stream stays live (no full-message delay) while
 * never emitting a half-substituted token.
 *
 * Guarantees:
 * - a complete known token is substituted exactly once, wherever it lands
 * - a token split at ANY boundary across any number of deltas substitutes
 *   identically to whole-text substitution
 * - unknown/confabulated tokens pass through verbatim (substituteTokens'
 *   contract), never crash, never invent values
 * - markers (`[REDACTED-…]`) are never held — the hyphen breaks the
 *   candidate shape, so markers stream immediately
 * - HOLD-BACK IS BOUNDED: the candidate shape caps at the maximum token
 *   shape (name run capped at 42 chars, counter run capped at 10 digits),
 *   so a hostile stream emitting `[AAAA…` or a token-shaped prefix followed
 *   by an endless digit run is NOT retained — past the cap it no longer
 *   matches the shape and flushes out verbatim. Memory cost is
 *   O(max token shape), never O(stream length).
 * - flush() emits the held tail verbatim (with any complete tokens in it
 *   substituted) for stream end
 *
 * TUI does NOT need this class: the markdown transformer receives the
 * FULL accumulated text block on every repaint, so `substituteTokens` on
 * the whole block is correct and stateless there.
 */

import { substituteTokens, type TokenVault } from "./vault.js"

/**
 * Trailing-suffix shape of an incomplete token: `[` followed by token
 * characters with no closing bracket yet. The name run is capped at the
 * maximum token shape (1 + up to 41 chars: `[A-Z]` + 40) AND the counter
 * run is capped at 10 digits, so a flood of `[AAAA…` or an unbounded
 * digit run after _` stops matching once it can no longer be a token and
 * flushes through.
 */
const PARTIAL_TAIL_RE = /(\[[A-Z][A-Z0-9_]{0,40}(?:_\d{0,9})?|\[)$/

export class StreamDesanitizer {
	private held = ""

	constructor(private readonly vault: TokenVault) {}

	/**
	 * Consume one delta; returns the text safe to emit now (substituted).
	 */
	push(delta: string): string {
		if (delta.length === 0 && this.held.length === 0) return ""
		const buffered = this.held + delta
		const partial = PARTIAL_TAIL_RE.exec(buffered)
		const holdLen = partial ? partial[0].length : 0
		this.held = buffered.slice(buffered.length - holdLen)
		return substituteTokens(this.vault, buffered.slice(0, buffered.length - holdLen))
	}

	/**
	 * Stream end: emit the held tail — any complete tokens in it still
	 * substitute; an incomplete tail goes out verbatim.
	 */
	flush(): string {
		const rest = substituteTokens(this.vault, this.held)
		this.held = ""
		return rest
	}
}
