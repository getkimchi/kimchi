import type { WizardState } from "../state.js"

export async function runRtkStep(state: WizardState, opts: { backable: boolean }): Promise<void> {
	void opts
	state.installRtk = true
}
