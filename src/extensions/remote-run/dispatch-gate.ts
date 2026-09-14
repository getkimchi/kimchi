/**
 * One-shot dispatch gate — structural consent for `dispatch_to_cloud_agent`.
 *
 * The tool is registered in the default tool set, so the model can emit a
 * call to it at any time — including when steered by indirect prompt
 * injection from file contents or tool output. The input-handler confirmation
 * dialog alone can't protect that surface: consent must be enforced where the
 * dispatch happens, not only where it's requested.
 *
 * Lifecycle:
 *
 *   input handler → user confirms  → arm()
 *   tool execute()                 → refuse unless isArmed()
 *   dispatch commits to a spawn    → disarm()  (one-shot: consumed)
 *   turn_end                       → disarm()  (armed but unused: expired)
 *
 * The gate binds to the consent EVENT, not the briefing content — the model
 * writes the briefing after confirmation, so content binding is impossible by
 * design. What this guarantees: at most one dispatch per explicit user
 * confirmation, and none without it.
 *
 * The gate lives in the remote-run extension factory closure (one per pi
 * session) — never module-global — so a confirmation in one session can
 * never arm a tool call in another.
 */

export interface DispatchGate {
	/** Mark the gate as ready — call only after explicit user confirmation. */
	arm(): void
	/** True while armed. Does not reset — use disarm() to consume/expire. */
	isArmed(): boolean
	/** Reset to unarmed: consumption at dispatch time, expiry on turn end. */
	disarm(): void
}

export function createDispatchGate(): DispatchGate {
	let armed = false
	return {
		arm() {
			armed = true
		},
		isArmed() {
			return armed
		},
		disarm() {
			armed = false
		},
	}
}
