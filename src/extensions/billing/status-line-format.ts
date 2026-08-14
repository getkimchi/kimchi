import type { Theme } from "@earendil-works/pi-coding-agent"
import { RST_FG, resolvedAccentFg } from "../../ansi.js"

export function formatCreditsStatusLine(amount: string, theme: Theme): string {
	return `${theme.fg("dim", "Credits:")} ${resolvedAccentFg(theme)}${amount}${RST_FG}`
}

export function formatBudgetStatusLine(budget: string, theme: Theme): string {
	return `${theme.fg("dim", "Budget:")} ${resolvedAccentFg(theme)}${budget}${RST_FG}`
}
