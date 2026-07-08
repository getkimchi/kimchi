import type { Theme } from "@earendil-works/pi-coding-agent"
import { RST_FG, resolvedAccentFg } from "../../ansi.js"
import type { BillingStatusLine } from "./status.js"

export function formatBillingStatusLine(line: BillingStatusLine, theme: Theme): string {
	switch (line.tone) {
		case "dim":
			return theme.fg("dim", line.text)
		default:
			return `${resolvedAccentFg(theme)}${line.text}${RST_FG}`
	}
}
