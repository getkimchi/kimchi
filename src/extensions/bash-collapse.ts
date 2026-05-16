import type { BashToolDetails, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { ToolBlockView, buildToolCallHeader, getTextContent } from "../components/tool-block.js"
import { isToolExpanded, registerToolCall } from "../expand-state.js"

export function collapseCommand(command: string | undefined): string {
	return (command ?? "").replace(/\n+/g, " ⏎ ")
}

export default function (pi: ExtensionAPI) {
	const baseDef = createBashToolDefinition(process.cwd())

	const def: ToolDefinition<typeof baseDef.parameters, BashToolDetails | undefined> = {
		...baseDef,

		execute(toolCallId, params, signal, onUpdate, ctx) {
			return createBashToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx)
		},

		renderCall(args, theme, ctx) {
			const view = ctx.lastComponent instanceof ToolBlockView ? ctx.lastComponent : new ToolBlockView()
			// Bash commands can be multiline (e.g. heredocs); collapse newlines
			// so the single-line header doesn't overflow onto multiple rows.
			const command = collapseCommand(args.command)
			buildToolCallHeader(view, "bash", command, theme, ctx)
			return view
		},

		renderResult(result, options, theme, context) {
			if (options.isPartial) {
				// ToolBlockView.render() ignores children, so addChild() output would be invisible.
				// Use setExtra() instead, which is actually rendered, and reuse the existing view
				// so the header set by renderCall stays put.
				const view = context.lastComponent instanceof ToolBlockView ? context.lastComponent : new ToolBlockView()
				const previewLines = getTextContent(result).split("\n").slice(-5)
				view.setExtra(previewLines.map((line) => theme.fg("toolOutput", line)))
				view.invalidate()
				return view
			}

			registerToolCall(context.toolCallId)

			if (isToolExpanded(context.toolCallId)) {
				return baseDef.renderResult?.(result, options, theme, context) ?? new Text("", 0, 0)
			}

			const view = context.lastComponent instanceof ToolBlockView ? context.lastComponent : new ToolBlockView()
			const trimmed = getTextContent(result).replace(/\n$/, "")
			const lineCount = trimmed ? trimmed.split("\n").length : 0

			view.setHeader("", "")
			view.setDivider((s: string) => theme.fg("borderMuted", s))
			view.setFooter(
				theme.fg("dim", `${lineCount} line${lineCount === 1 ? "" : "s"} of output`),
				theme.fg("dim", "ctrl+o to expand"),
			)
			view.setExtra([])
			return view
		},
	}

	pi.registerTool(def)
}
