/**
 * Mode predicates for the active ferment.
 *
 * `plan`: conversational, asks for confirmations.
 * `exec`: fully autonomous, auto-advances on phase completion.
 * `auto`: balanced — full instructions, planner decides when to act.
 */

import { getActive } from "./state.js"

export function isPlanMode(): boolean {
	const f = getActive()
	if (!f) return process.env.KIMCHI_PERMISSIONS === "plan"
	return f.mode === "plan"
}

export function isExecMode(): boolean {
	const f = getActive()
	if (!f) return false
	return f.mode === "exec"
}

export function isAutoMode(): boolean {
	const f = getActive()
	if (!f) return false
	return f.mode === "auto"
}
