import { visibleWidth } from "@earendil-works/pi-tui"
import type { Ferment, FermentStatus } from "../../ferment/types.js"
import type { ContinuationPolicy } from "./state.js"

export const FERMENT_STOP_POLICY_SHORTCUT = "f6"
export const FERMENT_STOP_POLICY_SHORTCUT_LABEL = "F6"

interface FermentFooterStyle {
	dim(text: string): string
	accent(text: string): string
}

export interface FermentFooterDisplay {
	text: string
	width: number
	prefix: string
	prefixWidth: number
}

const STATUS_LABELS: Record<FermentStatus, string> = {
	draft: "Draft",
	planned: "Planned",
	running: "Running",
	paused: "Paused",
	complete: "Complete",
	abandoned: "Abandoned",
}

export function canToggleFermentStopPolicy(ferment: Ferment | undefined): boolean {
	return ferment?.status === "planned" || ferment?.status === "running" || ferment?.status === "paused"
}

export function getFermentStopLabel(policy: ContinuationPolicy): string {
	return policy === "manual" ? "Phase Boundary" : "Completion"
}

export function formatFermentFooterDisplay(
	ferment: Ferment | undefined,
	policy: ContinuationPolicy,
	style: FermentFooterStyle,
): FermentFooterDisplay | null {
	if (!ferment || ferment.status === "complete" || ferment.status === "abandoned") return null

	const prefix = style.dim("Ferment: ")
	const separator = ` ${style.dim("·")} `
	const parts = [`${prefix}${style.accent(ferment.name)}`, style.dim(STATUS_LABELS[ferment.status])]

	if (canToggleFermentStopPolicy(ferment)) {
		parts.push(
			`${style.dim("Stop:")} ${style.accent(getFermentStopLabel(policy))} ${style.dim(`→ ${FERMENT_STOP_POLICY_SHORTCUT_LABEL}`)}`,
		)
	}

	const text = parts.join(separator)
	return {
		text,
		width: visibleWidth(text),
		prefix,
		prefixWidth: visibleWidth(prefix),
	}
}
