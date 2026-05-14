/**
 * Mode predicates for the active ferment.
 *
 * `plan`: conversational, asks for confirmations.
 * `exec`: fully autonomous; the agent calls activate_phase / start_step / complete_phase explicitly.
 * `auto`: balanced — full instructions, planner decides when to act.
 */

import type { Ferment } from "../../ferment/types.js"
import { getActive } from "./state.js"

export function isPlanFerment(f: Ferment | undefined | null): boolean {
	return f?.mode === "plan"
}

export function isExecFerment(f: Ferment | undefined | null): boolean {
	return f?.mode === "exec"
}

export function isAutoFerment(f: Ferment | undefined | null): boolean {
	return f?.mode === "auto"
}

export function isPlanMode(): boolean {
	const f = getActive()
	if (!f) return process.env.KIMCHI_PERMISSIONS === "plan"
	return isPlanFerment(f)
}

export function isExecMode(): boolean {
	return isExecFerment(getActive())
}

export function isAutoMode(): boolean {
	return isAutoFerment(getActive())
}
