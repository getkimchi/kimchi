// Side-effect imports register each integration. Import order doesn't matter
// — the registry is a Map keyed by ToolId — but the imports themselves do,
// otherwise byId() returns undefined for an unimported tool.
import "../integrations/claude-code.js"
import "../integrations/cursor.js"
import "../integrations/gsd2.js"
import "../integrations/openclaw.js"
import "../integrations/opencode.js"

import { cancel as clackCancel } from "@clack/prompts"
import type { WizardResult, WizardState } from "./state.js"
import { runAuthStep } from "./steps/auth.js"
import { runDoneStep } from "./steps/done.js"
import { runRtkStep } from "./steps/rtk.js"
import { runTelemetryStep } from "./steps/telemetry.js"
import { runWelcomeStep } from "./steps/welcome.js"

interface Step {
	name: string
	skip?: (state: WizardState) => boolean
	run: (state: WizardState, opts: { backable: boolean }) => Promise<void>
}

const STEPS: Step[] = [
	{ name: "auth", run: runAuthStep },
	{ name: "rtk", run: runRtkStep },
	{ name: "telemetry", run: runTelemetryStep },
]

/**
 * Drive the full setup wizard end-to-end. The runner walks {@link STEPS}
 * forward, calling each step and respecting `state.back` (rewind to the
 * previous non-skipped step) and `state.cancelled` (abort).
 *
 * Step order: welcome → auth → rtk → telemetry → done.
 */
export async function runWizard(): Promise<WizardResult> {
	const state: WizardState = {
		apiKey: "",
		mode: "override",
		scope: "global",
		selectedTools: [],
		installRtk: false,
		telemetryEnabled: true,
		cancelled: false,
		back: false,
	}

	const partial = (stepName?: string): WizardResult => ({
		cancelled: true,
		cancelledStep: stepName,
		apiKey: state.apiKey || undefined,
		mode: state.mode,
		scope: state.scope,
		telemetryEnabled: state.telemetryEnabled,
		selectedTools: [...state.selectedTools],
		configuredTools: [],
		rtkInstalled: false,
	})

	runWelcomeStep()

	let i = 0
	while (i < STEPS.length) {
		const step = STEPS[i]
		if (step.skip?.(state)) {
			i += 1
			continue
		}

		state.back = false
		const backable = previousActiveStep(state, i) >= 0
		await step.run(state, { backable })

		if (state.cancelled) {
			clackCancel("Cancelled.")
			return partial(step.name)
		}
		if (state.back) {
			const prev = previousActiveStep(state, i)
			i = prev >= 0 ? prev : i
			continue
		}
		i += 1
	}

	const outcome = await runDoneStep(state)
	return {
		cancelled: false,
		apiKey: state.apiKey,
		mode: state.mode,
		scope: state.scope,
		telemetryEnabled: state.telemetryEnabled,
		selectedTools: [...state.selectedTools],
		configuredTools: state.selectedTools.filter((id) =>
			outcome.successes.some((name) => name.toLowerCase().includes(id)),
		),
		rtkInstalled: outcome.rtkInstalled,
	}
}

function previousActiveStep(state: WizardState, from: number): number {
	for (let j = from - 1; j >= 0; j -= 1) {
		if (!STEPS[j].skip?.(state)) return j
	}
	return -1
}
