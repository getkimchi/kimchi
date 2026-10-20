import { wrapTextWithAnsi } from "@earendil-works/pi-tui"
import type { PRReportingConsent } from "./consent.js"

/** Lines fit a 60-column TUI, which pads notifications by one column on each side. */
const WIDTH = 58
/** "PR reporting" and a three-space gutter. */
const LABEL_WIDTH = 15

/** A label and its values, each starting a line of the value column. */
const row = (label: string, ...values: string[]) =>
	values
		.flatMap((value) => wrapTextWithAnsi(value, WIDTH - LABEL_WIDTH))
		.map((line, index) => `${(index ? "" : label).padEnd(LABEL_WIDTH)}${line}`)

/**
 * The `/pr-reporting status` text: the saved setting and whether the Kimchi gateway reports this session's requests.
 * `skipReason` describes this process, not the saved choice.
 */
export function statusText(consent: PRReportingConsent, skipReason: string | undefined): string {
	const reported = consent.enabled && !skipReason
	return [
		...row(
			"PR reporting",
			`${consent.enabled ? "Enabled" : "Disabled"} (${consent.source === "default" ? "SaaS default" : "explicit choice"})`,
		),
		...row(
			"This session",
			reported ? "Reported by the Kimchi gateway" : "Not reported",
			...(skipReason ? [`Reason: ${skipReason}`] : []),
		),
	].join("\n")
}
