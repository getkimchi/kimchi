import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent"
import { safePanelText } from "../../components/input-panel.js"
import { type ToolRenderContext, ToolText, toolHeader, withBranch } from "../tool-rendering.js"
import { overview } from "./presentation.js"
import type { PRWatchState } from "./types.js"

const ACTIONS: Record<string, string> = {
	start: "Start watching",
	status: "Refresh status",
	pause: "Pause fixes",
	stop: "Stop watching",
}

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
	const lines = [
		toolHeader("PR watch", "", theme) + theme.fg("muted", ` · ${ACTIONS[args.action ?? "start"] ?? ACTIONS.start}`),
	]
	if (ctx.expanded) {
		const account = args.allMine
			? `Your open ${args.provider === "gitlab" ? "GitLab MRs" : "GitHub PRs"}${args.host ? ` on ${args.host}` : ""}`
			: undefined
		for (const detail of [args.url, ...(args.targets ?? []).map(({ url }) => url), account, args.instructions])
			if (typeof detail === "string") lines.push(theme.fg("text", safePanelText(detail)))
	}
	return new ToolText(lines.join("\n"))
}

export function renderPRWatchResult(
	result: AgentToolResult<{ state: PRWatchState }>,
	{ expanded, isPartial }: ToolRenderResultOptions,
	theme: Theme,
	ctx: ToolRenderContext,
): ToolText {
	if (isPartial) return new ToolText(withBranch(theme.fg("muted", "Checking PR…"), theme))
	const text = safePanelText(
		result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n"),
	)
	if (expanded) return new ToolText(withBranch(theme.fg(ctx.isError ? "error" : "text", text), theme))
	const state = result.details?.state
	const summary = state && !ctx.isError ? overview(state) : undefined
	if (!summary) {
		const lines = text.trim().split("\n")
		const first = state?.message || lines[0] || "No PR status returned"
		return new ToolText(
			withBranch(
				theme.fg(ctx.isError ? "error" : "text", first) +
					(lines.length > 1 ? theme.fg("muted", " · ctrl+o for details") : ""),
				theme,
			),
		)
	}
	const lines = [
		theme.fg("text", `${summary.label} · ${summary.phase}`) + theme.fg("muted", ` · ${summary.fixes}`),
		theme.fg("text", summary.summary),
		...(summary.message ? [theme.fg("warning", safePanelText(summary.message))] : []),
	]
	return new ToolText(withBranch(lines.join("\n"), theme))
}
