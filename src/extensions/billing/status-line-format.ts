// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import type { Theme } from "@earendil-works/pi-coding-agent"
import { RST_FG, resolvedAccentFg } from "../../ansi.js"

export function formatCreditsStatusLine(amount: string, theme: Theme): string {
	return `${theme.fg("dim", "Credits:")} ${resolvedAccentFg(theme)}${amount}${RST_FG}`
}

export function formatBudgetStatusLine(budget: string, theme: Theme): string {
	return `${theme.fg("dim", "Budget:")} ${resolvedAccentFg(theme)}${budget}${RST_FG}`
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
