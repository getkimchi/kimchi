/**
 * skipped-agent-files-entry.ts — transcript notice for agent files that were
 * skipped because their frontmatter could not be parsed.
 *
 * Drawn as a custom session entry: it stays in the transcript, stays out of
 * model context, and follows the shared ctrl+o (app.tools.expand) toggle. The
 * layout mirrors the loaded-resources "skill issues" line — a one-line summary
 * that makes way for the per-file details only when expanded.
 *
 * Only the current session start is shown: every entry carries the token of the
 * start that appended it, and the renderer hides entries whose token is not the
 * current one. Entries written by earlier starts stay in the session file and
 * cost nothing on load (see docs/agents.md, "Invalid frontmatter").
 */

import type { EntryRenderer, Theme } from "@earendil-works/pi-coding-agent"
import { keyText } from "@earendil-works/pi-coding-agent"
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import { formatSkippedAgentFileRow, SKIPPED_AGENT_FILES_FIX_LINE } from "../personas/custom-agents.js"

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

function headerLine(left: string, expanded: boolean, theme: LineTheme, width: number): string {
	// Reserve the hint's width first so it stays visible on narrow terminals —
	// only the summary text truncates.
	const hint = theme.fg("dim", `(${keyText("app.tools.expand")} to ${expanded ? "collapse" : "expand"})`)
	const hintWidth = visibleWidth(hint)
	const maxLeft = width - hintWidth - 2
	if (maxLeft < 4) return truncateToWidth(left, width)
	const truncated = truncateToWidth(left, maxLeft)
	const pad = Math.max(0, width - visibleWidth(truncated) - hintWidth)
	return truncated + " ".repeat(pad) + hint
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
		private readonly expanded: boolean,
		private readonly theme: LineTheme,
	) {}

	private get summary(): string {
		const count = this.files.length
		return `[${count} agent issue${count === 1 ? "" : "s"}] Some agents were not loaded.`
	}

	render(width: number): string[] {
		if (width < 1) return []
		const left = this.expanded ? "[Agent issues]" : this.summary
		const lines = [headerLine(left, this.expanded, this.theme, width)]
		if (!this.expanded) return lines
		for (const { path, reason } of this.files) lines.push(...rowLines(path, reason, width))
		lines.push(...fixLines(width))
		return lines
	}

	invalidate(): void {}
}

/**
 * Build the entry renderer. `currentToken` returns the token of the session
 * start currently being rendered; the renderer hides notices from earlier
 * starts, so resuming a session does not stack one notice per resume.
 */
export function createSkippedAgentFilesRenderer(
	currentToken: () => string | undefined,
): EntryRenderer<SkippedAgentFilesEntryData> {
	return (entry, options, piTheme) => {
		const data: unknown = entry.data
		if (!isNoticeData(data)) return undefined
		if (data.files.length === 0) return undefined
		if (data.token !== currentToken()) return undefined
		return new SkippedAgentFilesLine(data.files, options.expanded, piTheme)
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
