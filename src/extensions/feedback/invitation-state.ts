// Module-level state shared between the feedback extension and the
// prompt-summary extension. The feedback extension sets the invitation
// when a model switch from auto-model to a concrete model is detected;
// the prompt-summary renderer reads it to decide whether to render the
// "Tell us why you switched (Ctrl+R)" invitation line below the model
// row. Clearing happens on submit/cancel via Ctrl+R, or on lifecycle
// events (turn_start / message_start / session_shutdown).

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
