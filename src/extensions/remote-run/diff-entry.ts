/**
 * diff-entry.ts — the persisted `remote_run:diff` transcript entry.
 *
 * Appended by the completion flow when the user views the streamed diff, so
 * the patch survives in the session transcript after the overlay closes (and
 * after a transcript reload — the renderer is a pure function of the entry
 * data). Custom entries do not participate in LLM context.
 */
import { Text } from "@earendil-works/pi-tui"
import { colorDiffLine, type DiffTheme } from "./ui/diff-viewer.js"

export const REMOTE_DIFF_ENTRY_TYPE = "remote_run:diff"

/** Patch lines persisted into the transcript at most — multi-MB diffs always
 *  land in full in the sibling patch file (patchPath). */
export const DIFF_MESSAGE_CAP_LINES = 400

const COLLAPSED_PREVIEW_LINES = 3

export interface RemoteRunDiffDetails {
	/** e.g. "kimchi/fix-login — 5 files (+120/-30)". */
	title: string
	/** e.g. "5 files changed, 120 insertions(+), 30 deletions(-)". */
	stat: string
	/** Unified patch text, capped to DIFF_MESSAGE_CAP_LINES at write time. */
	patch: string
	/** True when the persisted patch was capped — full content in patchPath. */
	capped?: boolean
	/** Transcript-side patch file with the full streamed diff. */
	patchPath?: string
}

/** Pure renderer — renders from entry data alone, so a reload of the
 *  persisted transcript shows the same output. */
export function renderRemoteRunDiff(
	entry: { data?: RemoteRunDiffDetails },
	options: { expanded: boolean },
	theme: DiffTheme,
): Text | undefined {
	const d = entry.data
	if (!d) return undefined

	const icon = theme.fg("accent", "◆")
	let text = `${icon} ${theme.bold(d.title)} ${theme.fg("dim", `· ${d.stat}`)}`
	if (d.patchPath) text += `\n  ${theme.fg("muted", `patch: ${d.patchPath}`)}`

	const patchLines = d.patch.split("\n")
	const shown = options.expanded ? patchLines : patchLines.slice(0, COLLAPSED_PREVIEW_LINES)
	for (const line of shown) {
		text += `\n${colorDiffLine(theme, line)}`
	}
	if (!options.expanded && patchLines.length > COLLAPSED_PREVIEW_LINES) {
		text += `\n  ${theme.fg("dim", `… ${patchLines.length - COLLAPSED_PREVIEW_LINES} more lines (expand to view)`)}`
	}
	if (options.expanded && d.capped) {
		text += `\n  ${theme.fg("dim", `… capped at ${DIFF_MESSAGE_CAP_LINES} lines — full patch: ${d.patchPath ?? "(not saved)"}`)}`
	}

	return new Text(text, 0, 0)
}
