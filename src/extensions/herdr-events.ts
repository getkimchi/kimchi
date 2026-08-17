/**
 * Event channels the herdr desktop app listens to on the extension event bus.
 *
 * herdr (sibling repo `src/integration/
 * assets/pi/herdr-agent-state.ts`) renders a per-pane agent status:
 * working / blocked / idle. Any extension that blocks on user input SHOULD
 * emit HERDR_EVENTS.BLOCKED around the wait so the pane surfaces it.
 *
 * PROTOCOL — balanced activation/deactivation pairs:
 *
 *   - Emit `{ active: true, label }` immediately BEFORE showing the prompt.
 *   - Emit `{ active: false }` exactly once when the prompt finishes, on
 *     EVERY exit path (submit, cancel, abort, throw). Structure the emit
 *     sites as `try { …prompt… } finally { deactivate }` — this module's
 *     contract is pairing, and `finally` is the only placement that survives
 *     all exits.
 *   - Pairs MAY nest (e.g. a per-subcommand permission prompt inside the
 *     compound-command prompt) and MAY interleave across surfaces. herdr
 *     refcounts activations, so depth matters, not order: the pane flips to
 *     `idle`/`working` only when every activation has been deactivated.
 *
 * Failure modes the protocol is designed around:
 *
 *   - A MISSED deactivation leaves the pane stuck on `blocked` until the
 *     session restarts. herdr cannot detect this — do not fire-and-forget
 *     activations without a guaranteed matching deactivation.
 *   - A SPURIOUS extra deactivation is tolerated: herdr clamps its counter
 *     at zero.
 *
 * Guard against accidental activation emission: only emit after all early
 * returns that skip the prompt (validation failure, no UI attached, no
 * prompter available). Emitting `{active: true}` and then never prompting
 * is the canonical way to wedge a herdr pane.
 *
 * Privacy: labels are human-readable status strings shown in the herdr UI.
 * Keep them short (tool name or question prompt); never include raw tool
 * arguments, command text, or file contents.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent"

export const HERDR_EVENTS = {
	BLOCKED: "herdr:blocked",
} as const

export type HerdrEventChannel = (typeof HERDR_EVENTS)[keyof typeof HERDR_EVENTS]

export interface HerdrBlockedPayload {
	/** `true` opens a wait on the user; `false` closes the most recent one. */
	active: boolean
	/** Short human-readable reason for the wait (e.g. "Permission: write").
	 *  Only meaningful on activation and currently only displayed while this
	 *  is the most recent activation — nested activations overwrite it. */
	label?: string
}

/**
 * Run `fn` inside a balanced herdr:blocked activation pair (see the PROTOCOL
 * section above). Use this around any prompt that waits on the user so the
 * pairing cannot drift at the call site.
 *
 * Emitting through a missing bus is a no-op so heads-down surfaces (tests,
 * subagents without the desktop app) don't need to stub the channel.
 */
export async function withBlocked<T>(events: EventBus | undefined, label: string, fn: () => Promise<T>): Promise<T> {
	if (!events) return fn()
	events.emit(HERDR_EVENTS.BLOCKED, { active: true, label } satisfies HerdrBlockedPayload)
	try {
		return await fn()
	} finally {
		events.emit(HERDR_EVENTS.BLOCKED, { active: false } satisfies HerdrBlockedPayload)
	}
}
