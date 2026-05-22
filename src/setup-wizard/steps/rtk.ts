import { isRtkInstalled } from "../../resources/rtk-install.js"
import type { WizardState } from "../state.js"

export async function runRtkStep(state: WizardState, opts: { backable: boolean }): Promise<void> {
	void opts
	if (isRtkInstalled()) {
		state.installRtk = false
		return
	}
	state.installRtk = true
}
