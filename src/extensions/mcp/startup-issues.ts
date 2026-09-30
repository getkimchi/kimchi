/**
 * Collapsed-by-default widget for MCP startup issues.
 *
 * MCP configuration/loading issues (config parse errors, legacy keys,
 * OAuth migration notes, untrusted project config) used to print as one
 * `Warning:` notification line per issue on every session start. Instead
 * they render as a single collapsed notice above the editor — one dim
 * summary row, expanded by ctrl+o or a click (see `CollapsibleNotice`).
 *
 * The notice is a UI-only widget, not a transcript message, so it never
 * reaches the LLM context or session history.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { CollapsibleNotice } from "../../components/collapsible-notice.js"

/** Widget key for the MCP startup-issues notice. */
export const MCP_STARTUP_ISSUES_WIDGET_KEY = "kimchi-mcp-startup-issues"

export function buildMcpStartupIssuesSummary(warnings: readonly string[]): string {
	return `[${warnings.length} MCP issue${warnings.length === 1 ? "" : "s"}] Some MCP configuration needs attention.`
}

/** Show the collapsed MCP issues notice, or clear it when there are none. */
export function showMcpStartupIssues(ctx: ExtensionContext, warnings: readonly string[]): void {
	if (warnings.length === 0) {
		ctx.ui.setWidget(MCP_STARTUP_ISSUES_WIDGET_KEY, undefined)
		return
	}
	const content = { summary: buildMcpStartupIssuesSummary(warnings), title: "[MCP issues]", entries: warnings }
	ctx.ui.setWidget(
		MCP_STARTUP_ISSUES_WIDGET_KEY,
		(_tui, theme) =>
			new CollapsibleNotice(
				theme,
				() => content,
				() => ctx.ui.getToolsExpanded(),
			),
	)
}
