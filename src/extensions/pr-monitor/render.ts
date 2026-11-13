import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent"
import { safePanelText } from "../../components/input-panel.js"
import { type ToolRenderContext, ToolText, toolHeader, withBranch } from "../tool-rendering.js"
import {
	prWatchFixesLabel,
	prWatchPhaseLabel,
	prWatchPlural,
	prWatchSummary,
	prWatchTargetLabel,
} from "./presentation.js"
import { PLAN_MODE_MESSAGE, type PRMonitorState } from "./types.js"

export function renderPRWatchCall(
	args: {
		action?: string
		url?: string
		targets?: { url: string }[]
		allMine?: boolean
		provider?: string
		host?: string
		instructions?: string
	},
	theme: Theme,
	ctx: ToolRenderContext,
): ToolText {
	const labels: Record<string, string> = {
		start: "Start watching",
		status: "Refresh status",
		pause: "Pause fixes",
		stop: "Stop watching",
	}
	const lines = [
		toolHeader("PR watch", "", theme) + theme.fg("muted", ` · ${labels[args.action ?? "start"] ?? "Start watching"}`),
	]
	if (ctx.expanded) {
		if (typeof args.url === "string") lines.push(theme.fg("text", safePanelText(args.url)))
		if (args.targets) for (const target of args.targets) lines.push(theme.fg("text", safePanelText(target.url)))
		if (args.allMine)
			lines.push(
				theme.fg(
					"text",
					safePanelText(
						`Your open ${args.provider === "gitlab" ? "GitLab MRs" : "GitHub PRs"}${args.host ? ` on ${args.host}` : ""}`,
					),
				),
			)
		if (typeof args.instructions === "string") lines.push(theme.fg("text", safePanelText(args.instructions)))
	}
	return new ToolText(lines.join("\n"))
}

export function renderPRWatchResult(
	result: AgentToolResult<{ state: PRMonitorState }>,
	{ expanded, isPartial }: ToolRenderResultOptions,
	theme: Theme,
	ctx: ToolRenderContext,
): ToolText {
	const text = safePanelText(
		result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n"),
	)
	if (isPartial) return new ToolText(withBranch(theme.fg("muted", "Checking PR…"), theme))
	if (expanded) return new ToolText(withBranch(theme.fg(ctx.isError ? "error" : "text", text), theme))
	const state = result.details?.state
	if (ctx.isError || !state) {
		const lines = text.trim().split("\n")
		return new ToolText(
			withBranch(
				theme.fg(ctx.isError ? "error" : "text", lines[0] || "No PR status returned") +
					(lines.length > 1 ? theme.fg("muted", " · ctrl+o for details") : ""),
				theme,
			),
		)
	}
	const target =
		state.watches && state.watches.length > 1
			? `${state.watches.filter(({ state }) => state.enabled).length} ${prWatchPlural(state)}`
			: state.pullRequest
				? prWatchTargetLabel(state.pullRequest)
				: "This branch"
	const lines = [
		theme.fg("text", `${target} · ${prWatchPhaseLabel(state)}`) + theme.fg("muted", ` · ${prWatchFixesLabel(state)}`),
		theme.fg("text", prWatchSummary(state)),
	]
	if (state.message && state.message !== PLAN_MODE_MESSAGE)
		lines.push(theme.fg("warning", safePanelText(state.message)))
	return new ToolText(withBranch(lines.join("\n"), theme))
}
