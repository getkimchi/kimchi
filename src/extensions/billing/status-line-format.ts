import type { Theme } from "@earendil-works/pi-coding-agent"
import { RST_FG, resolvedAccentFg } from "../../ansi.js"
import type { BillingStatusLine } from "./status.js"

export function formatBillingStatusLine(line: BillingStatusLine, theme: Theme): string {
	const parts: string[] = []
	if (line.amount) parts.push(`${theme.fg("dim", "Credits:")} ${resolvedAccentFg(theme)}${line.amount}${RST_FG}`)
	if (line.budget) parts.push(`${theme.fg("dim", "Budget:")} ${resolvedAccentFg(theme)}${line.budget}${RST_FG}`)
	return parts.join(theme.fg("dim", " · "))
}
