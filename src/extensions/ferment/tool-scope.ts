import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Ferment } from "../../ferment/types.js"
import type { FermentRuntime } from "./runtime.js"

export const FERMENT_TOOL_NAMES = [
	"create_ferment",
	"propose_phases",
	"list_ferments",
	"scope_ferment",
	"update_scope_field",
	"set_ferment_mode",
	"complete_ferment",
	"activate_phase",
	"refine_phase",
	"complete_phase",
	"skip_phase",
	"fail_phase",
	"start_step",
	"complete_step",
	"verify_step",
	"skip_step",
	"fail_step",
	"add_decision",
	"add_memory",
] as const

const FERMENT_TOOL_NAME_SET = new Set<string>(FERMENT_TOOL_NAMES)

export function disableFermentTools(pi: ExtensionAPI): void {
	pi.setActiveTools(pi.getActiveTools().filter((name) => !FERMENT_TOOL_NAME_SET.has(name)))
}

export function enableFermentTools(pi: ExtensionAPI): void {
	const activeWithoutFerment = pi.getActiveTools().filter((name) => !FERMENT_TOOL_NAME_SET.has(name))
	const registeredFermentTools = pi
		.getAllTools()
		.map((tool) => tool.name)
		.filter((name) => FERMENT_TOOL_NAME_SET.has(name))

	pi.setActiveTools([...new Set([...activeWithoutFerment, ...registeredFermentTools])])
}

export function shouldEnableFermentTools(ferment: Ferment | undefined): boolean {
	return (
		ferment !== undefined &&
		ferment.status !== "paused" &&
		ferment.status !== "complete" &&
		ferment.status !== "abandoned"
	)
}

export function syncFermentToolScope(pi: ExtensionAPI, ferment: Ferment | undefined): void {
	if (shouldEnableFermentTools(ferment)) {
		enableFermentTools(pi)
	} else {
		disableFermentTools(pi)
	}
}

export function setActiveFerment(pi: ExtensionAPI, runtime: FermentRuntime, ferment: Ferment | undefined): void {
	runtime.setActive(ferment)
	syncFermentToolScope(pi, ferment)
}
