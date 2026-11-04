// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { truncateToWidth } from "@earendil-works/pi-tui"

/**
 * Hard-truncate every rendered line to the terminal width.
 *
 * pi-tui crashes when a custom component emits a line wider than the
 * terminal, so every custom renderer must pass its final output through
 * truncation instead of open-coding
 * `lines.map((line) => truncateToWidth(line, width))`.
 */
export function truncateLinesToWidth(lines: string[], width: number): string[] {
	return lines.map((line) => truncateToWidth(line, width))
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
