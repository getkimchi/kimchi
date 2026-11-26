/**
 * skipped-agent-files-entry.ts — transcript notice for agent files that were
 * skipped because their frontmatter could not be parsed.
 *
 * Drawn as a custom session entry: it stays in the transcript, stays out of
 * model context, and follows the shared ctrl+o (app.tools.expand) toggle. The
 * layout mirrors the loaded-resources "skill issues" line — a one-line summary
 * that makes way for the per-file details only when expanded.
 *
 * In fullscreen mode a left click toggles this notice alone. Click and ctrl+o
 * drive one state: either one flips the notice, so the hint on the line is
 * always what the key will do. pi rebuilds the component (re-running the
 * renderer) on every ctrl+o and every invalidate, so that state lives in the
 * renderer, keyed by entry id — not on the component, where the next rebuild
 * would drop it.
 *
 * Only the current session start is shown: every entry carries the token of the
 * start that appended it, and the renderer hides entries whose token is not the
 * current one. Entries written by earlier starts stay in the session file and
 * cost nothing on load (see docs/agents.md, "Invalid frontmatter").
 */

import type { EntryRenderer, Theme } from "@earendil-works/pi-coding-agent"
import { keyText } from "@earendil-works/pi-coding-agent"
import {
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui"
import {
	formatSkippedAgentFileRow,
	formatSkippedAgentFilesSummary,
	SKIPPED_AGENT_FILES_FIX_LINE,
} from "../personas/custom-agents.js"

/** Custom entry type holding the skipped-file notice. */
export const SKIPPED_AGENT_FILES_ENTRY = "agents:skipped-files"

export interface SkippedAgentFilesEntryData {
	/** Session start that wrote the entry — see `createSkippedAgentFilesRenderer`. */
	token: string
	/** `path` is the display path (relative to the session cwd when inside it). */
	files: { path: string; reason: string }[]
}

type LineTheme = Pick<Theme, "fg">

/**
 * Below this width the details truncate instead of wrapping: a long path would
 * otherwise turn one row into dozens of lines and bury the rest of the notice.
 */
const WRAP_MIN_WIDTH = 20

/**
 * Left pad, matching pi's own transcript notices (`showWarning`/`showStatus`
 * render `ThemedText(..., 1, 0)`). A custom entry is otherwise drawn at column
 * 0, one column left of the warning right above it.
 */
const LEFT_PAD = " "

/**
 * Disclosure markers. The small triangles are one cell wide in every terminal;
 * the large `▶` is ambiguous-width, can render as an emoji, and already means
 * "in progress" in the todos widget. The marker trails the sentence: in front
 * it would push "Warning:" off column 1, out of line with pi's own "Warning:"
 * notices right above.
 */
const COLLAPSED_MARKER = "▸"
const EXPANDED_MARKER = "▾"

function headerLine(sentence: string, expanded: boolean, theme: LineTheme, width: number): string {
	// Reserve the hint's width first, then the marker's, so both stay visible
	// on narrow terminals — only the sentence truncates.
	const hint = theme.fg("dim", `(${keyText("app.tools.expand")} to ${expanded ? "collapse" : "expand"})`)
	const hintWidth = visibleWidth(hint)
	const marker = ` ${expanded ? EXPANDED_MARKER : COLLAPSED_MARKER}`
	const maxLeft = width - hintWidth - 2
	// Warning colour on the header only: the detail rows below stay plain so a
	// notice can be long and still readable. truncateToWidth is ANSI-aware and
	// ends a cut string with a colour reset, so the marker is painted on its
	// own — appended to the same span it would lose the colour after a cut.
	const painted = theme.fg("warning", sentence)
	if (maxLeft < 4) return truncateToWidth(painted, width)
	const left = truncateToWidth(painted, maxLeft - visibleWidth(marker)) + theme.fg("warning", marker)
	const pad = Math.max(0, width - visibleWidth(left) - hintWidth)
	return left + " ".repeat(pad) + hint
}

/**
 * One file row. Continuation lines are indented further than the row itself so
 * a wrapped row reads as one entry; wrapping the pre-indented line instead
 * drops the indent and starts with a blank line.
 */
function rowLines(path: string, reason: string, width: number): string[] {
	const content = formatSkippedAgentFileRow(path, reason)
	if (width < WRAP_MIN_WIDTH) return [truncateToWidth(`  ${content}`, width)]
	// Reserve the deepest indent (4) so no wrapped line can exceed the width.
	const parts = wrapTextWithAnsi(content, Math.max(1, width - 4)).filter((line) => line.length > 0)
	return parts.map((part, index) => truncateToWidth(`${index === 0 ? "  " : "    "}${part}`, width))
}

function fixLines(width: number): string[] {
	if (width < WRAP_MIN_WIDTH) return [truncateToWidth(SKIPPED_AGENT_FILES_FIX_LINE, width)]
	return wrapTextWithAnsi(SKIPPED_AGENT_FILES_FIX_LINE, width)
		.filter((line) => line.length > 0)
		.map((line) => truncateToWidth(line, width))
}

/**
 * The notice body. Every returned line is at most `width` columns: pi-tui
 * throws on an over-wide line, and that throw happens during paint, where a
 * custom entry has no error boundary — the process dies on ctrl+o.
 */
class SkippedAgentFilesLine implements Component {
	constructor(
		private readonly files: { path: string; reason: string }[],
		private expanded: boolean,
		private readonly theme: LineTheme,
		private readonly onClickToggle: () => void,
	) {}

	/** Keep this child stable across rebuilds: pi's mouse layout retains child references. */
	setExpanded(expanded: boolean): void {
		this.expanded = expanded
	}

	private get summary(): string {
		// Same sentence as the plain warning, so the surfaces cannot drift. The
		// header adds a marker after it that says the line opens, in every mode
		// — a "click" hint would be false in regular mode, which has no mouse.
		return `Warning: ${formatSkippedAgentFilesSummary(this.files.length)}`
	}

	render(width: number): string[] {
		const contentWidth = width - LEFT_PAD.length
		if (contentWidth < 1) return []
		// The sentence does not change when expanded — only the marker and the
		// hint do — so the count stays visible while reading the details.
		const lines = [headerLine(this.summary, this.expanded, this.theme, contentWidth)]
		if (this.expanded) {
			for (const { path, reason } of this.files) lines.push(...rowLines(path, reason, contentWidth))
			lines.push(...fixLines(contentWidth))
		}
		// The pad is added last so every line keeps one column of margin while
		// the hint stays flush with the right edge.
		return lines.map((line) => LEFT_PAD + line)
	}

	/**
	 * Left click anywhere on the notice toggles it, leaving the rest of the
	 * transcript as it is. Only fullscreen mode delivers mouse events; in
	 * regular mode this is never called and ctrl+o is the way in.
	 */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined
		this.expanded = !this.expanded
		this.onClickToggle()
		return { handled: true }
	}

	invalidate(): void {}
}

/**
 * Build the entry renderer. `currentToken` returns the token of the session
 * start currently being rendered; the renderer hides notices from earlier
 * starts, so resuming a session does not stack one notice per resume.
 *
 * `flipped` holds the notices a click has put out of step with the shared
 * ctrl+o toggle: such a notice shows the opposite of `options.expanded`. A
 * click moves the entry in or out of the set and ctrl+o flips
 * `options.expanded`, so both invert what is on screen — one state, two inputs.
 * The cost is that a clicked notice then runs opposite to the tool blocks
 * until it is clicked again.
 */
export function createSkippedAgentFilesRenderer(
	currentToken: () => string | undefined,
): EntryRenderer<SkippedAgentFilesEntryData> {
	const flipped = new Set<string>()
	const lines = new Map<string, SkippedAgentFilesLine>()
	let activeToken: string | undefined
	return (entry, options, piTheme) => {
		const data: unknown = entry.data
		if (!isNoticeData(data)) return undefined
		if (data.files.length === 0) return undefined
		const latestStart = currentToken()
		if (latestStart !== activeToken) {
			activeToken = latestStart
			flipped.clear()
			lines.clear()
		}
		if (data.token !== latestStart) return undefined
		const expanded = options.expanded !== flipped.has(entry.id)
		const cached = lines.get(entry.id)
		if (cached) {
			cached.setExpanded(expanded)
			return cached
		}
		const line = new SkippedAgentFilesLine(data.files, expanded, piTheme, () => {
			if (!flipped.delete(entry.id)) flipped.add(entry.id)
		})
		lines.set(entry.id, line)
		return line
	}
}

/** Entries from other versions are untrusted input — validate before rendering. */
function isNoticeData(data: unknown): data is SkippedAgentFilesEntryData {
	if (typeof data !== "object" || data === null) return false
	const { token, files } = data as { token?: unknown; files?: unknown }
	if (typeof token !== "string" || !Array.isArray(files)) return false
	return files.every(
		(file) =>
			typeof file === "object" &&
			file !== null &&
			typeof (file as { path?: unknown }).path === "string" &&
			typeof (file as { reason?: unknown }).reason === "string",
	)
}
