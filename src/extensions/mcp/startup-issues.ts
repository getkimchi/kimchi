/**
 * Transcript message for MCP startup issues.
 *
 * MCP configuration/loading issues (config parse errors, legacy keys,
 * OAuth migration notes, untrusted project config) are delivered as a
 * single display-only transcript message at session start — collapsed by
 * default like tool output (ctrl+o expands) — so they scroll away with
 * history instead of staying pinned as a widget above the editor for the
 * whole session.
 *
 * The message is sent once on `session_start` with reason "startup".
 * Resumed/forked/reloaded sessions already hold the block in their
 * history (renderers are re-applied on load), so re-sending would
 * duplicate it.
 *
 * The full issue list lives in `details` (UI-only); the LLM context gets
 * just the one-line `<system-annotation>` content, so a long issue list
 * costs a constant number of tokens (see `noticeMessageRenderer`).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { CollapsibleNoticeContent } from "../../components/collapsible-notice.js"

/** Custom message type for the MCP startup-issues transcript block. */
export const MCP_STARTUP_ISSUES_MESSAGE_TYPE = "kimchi-mcp-startup-issues"

export function buildMcpStartupIssuesSummary(warnings: readonly string[]): string {
	return `[${warnings.length} MCP issue${warnings.length === 1 ? "" : "s"}] Some MCP configuration needs attention.`
}

/** Send the MCP issues transcript message; no-op when there are none. */
export function showMcpStartupIssues(pi: ExtensionAPI, warnings: readonly string[]): void {
	if (warnings.length === 0) return
	const details: CollapsibleNoticeContent = {
		summary: buildMcpStartupIssuesSummary(warnings),
		title: "[MCP issues]",
		entries: warnings,
	}
	pi.sendMessage(
		{
			customType: MCP_STARTUP_ISSUES_MESSAGE_TYPE,
			content: [
				{ type: "text", text: `<system-annotation>MCP startup issues (${warnings.length})</system-annotation>` },
			],
			display: true,
			details,
		},
		{ triggerTurn: false },
	)
}
