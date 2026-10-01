// Whether a model-switch feedback invitation is currently open.
//
// Set when the feedback extension sees a switch from the auto-model to a
// concrete model, and read there to decide what Ctrl+R does: while an
// invitation is live the key opens the model-switch dialog, and the rest
// of the time it stays unclaimed so the built-in `app.session.rename`
// keeps working.
//
// Cleared when the user answers (including an empty "no reason" submit),
// and on the `turn_start` / `session_start` / `session_shutdown`
// lifecycle events so an invitation cannot outlive its turn or leak into
// a replacement session. Pressing Esc deliberately does NOT clear it —
// the rendered "(Ctrl+R)" hint is still on screen and has to keep working.
//
// The hint itself is drawn by this extension's own entry renderer from
// the appended `model-switch-feedback` entry, not from this state.
//
// Module-level rather than per-session because the extension is
// instantiated once per process; the lifecycle resets above are what keep
// it from going stale.

export interface ModelSwitchInvitationState {
	modelName: string
	modelId: string
}

let invitation: ModelSwitchInvitationState | null = null

export function getModelSwitchInvitation(): ModelSwitchInvitationState | null {
	return invitation
}

export function setModelSwitchInvitation(state: ModelSwitchInvitationState): void {
	invitation = state
}

export function clearModelSwitchInvitation(): void {
	invitation = null
}
