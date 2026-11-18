/**
 * skipped-agent-files-entry.ts — transcript notice for agent files that were
 * skipped because their frontmatter could not be parsed.
 *
 * Drawn as a custom session entry: it stays in the transcript, stays out of
 * model context, and follows the shared ctrl+o (app.tools.expand) toggle. The
 * layout mirrors the loaded-resources "skill issues" line — a one-line summary
 * that makes way for the per-file details only when expanded.
 *
 * A notice is visible only in the session start that wrote it (§"once per
 * start"): every entry carries the token of the start that appended it, and the
 * renderer hides entries whose token is not the current one. Entries written by
 * earlier starts stay in the session file and cost nothing on load.
 */

import type { EntryRenderer } from "@earendil-works/pi-coding-agent"
import { keyText } from "@earendil-works/pi-coding-agent"
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"

/** Custom entry type holding the skipped-file notice. */
export const SKIPPED_AGENT_FILES_ENTRY = "agents:skipped-files"

export interface SkippedAgentFilesEntryData {
	/** Session start that wrote the entry — see `createSkippedAgentFilesRenderer`. */
	token: string
	/** `path` is the display path (relative to the session cwd when inside it). */
	files: { path: string; reason: string }[]
}

/** The slice of pi's Theme the line needs; pi passes its full Theme in. */
interface LineTheme {
	fg(color: string, text: string): string
}

const FIX_LINE = "Fix the YAML frontmatter to load them."

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
		// YAML errors are long: wrap instead of cutting them, then clamp each
		// wrapped line as a belt-and-braces guard on the width contract.
		for (const { path, reason } of this.files) lines.push(`  ${path} — ${reason}`)
		lines.push(FIX_LINE)
		return lines.flatMap((line) => wrapTextWithAnsi(line, width).map((wrapped) => truncateToWidth(wrapped, width)))
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
