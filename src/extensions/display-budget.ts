/**
 * Display-side budget helpers for the TUI.
 *
 * The TUI must never hold long-lived copies of mirrored content, and must
 * never render the raw lazy marker text that externalized messages carry in
 * memory. These helpers decide what a pane actually materializes for display,
 * resolving markers through the tool-output store (transient read) and
 * capping oversized text with an expandable preview.
 *
 * Display may be capped — the model-facing content is hydrated
 * separately (see tool-output-externalizer) and stays byte-identical.
 */
import { parseMarker, readMarkerText } from "./tool-output-store.js"

/** Default cap for a single displayed text block. */
export const DISPLAY_OUTPUT_MAX_CHARS = 16_000

export interface DisplayBudgetResult {
	/** The text a pane should render. */
	display: string
	/** Full text when `display` is a truncated preview, else undefined. */
	full?: string
	/** True when `text` was an externalized marker resolved from the mirror. */
	resolvedMirror?: boolean
}

/**
 * Prepare a text value for display:
 *  - markers are resolved to the mirrored full text (transient read) so the UI
 *    never shows the raw marker;
 *  - text above `maxChars` becomes a head+tail preview with the full value
 *    available to expand on demand.
 */
export function displayBudgetText(text: string, maxChars = DISPLAY_OUTPUT_MAX_CHARS): DisplayBudgetResult {
	if (text.length === 0) return { display: text }
	const handle = parseMarker(text)
	if (handle) {
		const full = readMarkerText(text)
		if (full !== undefined) {
			const inner = displayBudgetText(full, maxChars)
			return { ...inner, resolvedMirror: true }
		}
		// The mirror is gone (temp cleanup / different process): fall back to a
		// placeholder caption instead of leaking the raw marker into the UI.
		return {
			display: `mirrored content unavailable (${handle.length} bytes, source no longer readable)`,
			resolvedMirror: true,
		}
	}
	if (text.length <= maxChars) return { display: text }
	const head = text.slice(0, Math.floor(maxChars / 2))
	const tail = text.slice(text.length - Math.floor(maxChars / 2))
	return { display: `${head}\n… [${text.length} chars — expand to view] …\n${tail}`, full: text }
}
