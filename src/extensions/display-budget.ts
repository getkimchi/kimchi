/**
 * Display-side marker resolution for the TUI.
 *
 * Externalized tool results carry a compact `[kimchi-ext:tool]` marker in the
 * in-memory message; the transcript must never render that raw marker text.
 * The renderer seam (tool-rendering.ts) resolves markers through this module
 * at render time — a transient read through the tool-output store, never a
 * long-lived copy in component state.
 *
 * When the mirror is gone (temp cleanup, different process), a placeholder
 * caption replaces the marker instead of leaking the handle JSON into the UI.
 *
 * Display budgeting (line/char caps) stays with the individual tool
 * renderers — this module only resolves markers.
 */
import { parseMarker, readMarkerText } from "./tool-output-store.js"

/**
 * Resolve an exact marker string for display:
 *  - a store-issued marker resolves to the mirrored full text;
 *  - an unreadable marker resolves to a placeholder caption;
 *  - any other string is not a marker (returns `undefined`).
 */
export function resolveMarkerForDisplay(text: string): string | undefined {
	const handle = parseMarker(text)
	if (!handle) return undefined
	const full = readMarkerText(text)
	if (full !== undefined) return full
	return `mirrored content unavailable (${handle.length} bytes, source no longer readable)`
}
