import type { Theme } from "@earendil-works/pi-coding-agent"
import { RST_FG, resolvedAccentFg } from "../../ansi.js"
import type { BillingStatusLine } from "./status.js"

export function formatBillingStatusLine(line: BillingStatusLine, theme: Theme): string {
	return `${theme.fg("dim", "Credits:")} ${resolvedAccentFg(theme)}${line.amount}${RST_FG}`
}
