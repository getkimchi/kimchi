import type { Theme } from "@earendil-works/pi-coding-agent"
import { RST_FG, resolvedAccentFg, resolvedSemanticFg } from "../../ansi.js"
import type { BillingStatusLine } from "./status.js"

export function formatBillingStatusLine(line: BillingStatusLine, theme: Theme): string {
	switch (line.tone) {
		case "dim":
			return theme.fg("dim", line.text)
		case "warning":
			return `${resolvedSemanticFg(theme, "warning")}${line.text}${RST_FG}`
		case "error":
			return `${resolvedSemanticFg(theme, "error")}${line.text}${RST_FG}`
		default:
			return `${resolvedAccentFg(theme)}${line.text}${RST_FG}`
	}
}
