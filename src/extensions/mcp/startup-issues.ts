/**
 * Collapsed-by-default rendering for MCP startup issues.
 *
 * MCP configuration/loading issues (config parse errors, legacy keys,
 * OAuth migration notes, untrusted project config) used to print as one
 * `Warning:` notification line per issue on every session start. Instead
 * they are now sent as a single custom transcript message that renders
 * collapsed by default — one dim summary row with a right-aligned
 * "(ctrl+o to expand)" hint, mirroring the skill-conflicts startup
 * summary and the collapsed tool-row convention. Click toggles only this
 * line; ctrl+o toggles it together with tool output via the global
 * `setToolsExpanded()` pass (the host re-invokes this renderer with the
 * new `expanded` flag).
 */

import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent"
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { buildAlignedLine } from "../../components/tool-block.js"

/** Custom message type carrying the startup MCP issues, with `details` holding the warnings. */
export const MCP_STARTUP_ISSUES_CUSTOM_TYPE = "kimchi-mcp-startup-issues"

export interface McpStartupIssuesDetails {
	warnings: string[]
}

export function buildMcpStartupIssuesSummary(warnings: readonly string[]): string {
	return `[${warnings.length} MCP issue${warnings.length === 1 ? "" : "s"}] Some MCP configuration needs attention.`
}

class McpStartupIssuesLine implements Component {
	constructor(
		private readonly theme: Theme,
		private readonly summary: string,
		private readonly warnings: readonly string[],
		private expanded: boolean,
	) {}

	render(width: number): string[] {
		const left = this.expanded ? this.theme.fg("warning", "[MCP issues]") : this.theme.fg("dim", this.summary)
		const hint = this.theme.fg("dim", `(ctrl+o to ${this.expanded ? "collapse" : "expand"})`)
		const lines = [buildAlignedLine(left, hint, width)]
		if (this.expanded) {
			for (const warning of this.warnings) {
				for (const detail of warning.split("\n")) {
					lines.push(visibleWidth(detail) > width ? truncateToWidth(detail, width) : detail)
				}
			}
		}
		return lines
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined
		this.expanded = !this.expanded
		return { handled: true }
	}

	invalidate(): void {}
}

/**
 * Renderer for the collapsed MCP-issues line. `options.expanded` reflects
 * the global ctrl+o state at render time; the host re-invokes the renderer
 * whenever it changes, so local click state is always reset by a global
 * toggle — same semantics as the skill-conflicts summary row.
 */
export const mcpStartupIssuesRenderer: MessageRenderer<McpStartupIssuesDetails> = (message, options, theme) => {
	const warnings = message.details?.warnings
	if (!warnings || warnings.length === 0) return undefined
	return new McpStartupIssuesLine(theme, buildMcpStartupIssuesSummary(warnings), warnings, options.expanded)
}
