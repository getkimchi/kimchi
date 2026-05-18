import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import {
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent"
import type { Theme } from "@earendil-works/pi-coding-agent"
import type { TSchema } from "typebox"
import { ToolBlockView, buildToolCallHeader, getTextContent } from "../components/tool-block.js"
import { isToolExpanded, registerToolCall } from "../expand-state.js"

const ANSI_RESET = "\x1b[0m"
const ANSI_GREEN = "\x1b[32m"
const ANSI_RED = "\x1b[31m"
const ANSI_CYAN = "\x1b[36m"
const ANSI_DIM = "\x1b[2m"

function colorizeDiff(content: string): string {
	return content
		.split("\n")
		.map((line) => {
			if (line.startsWith("+++") || line.startsWith("---")) return `${ANSI_DIM}${line}${ANSI_RESET}`
			if (line.startsWith("+")) return `${ANSI_GREEN}${line}${ANSI_RESET}`
			if (line.startsWith("-")) return `${ANSI_RED}${line}${ANSI_RESET}`
			if (line.startsWith("@@")) return `${ANSI_CYAN}${line}${ANSI_RESET}`
			return `${ANSI_DIM}${line}${ANSI_RESET}`
		})
		.join("\n")
}

function diffSummary(content: string): string {
	let added = 0
	let removed = 0
	for (const line of content.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++
		else if (line.startsWith("-") && !line.startsWith("---")) removed++
	}
	if (added === 0 && removed === 0) return "no changes"
	const parts: string[] = []
	if (added > 0) parts.push(`${ANSI_GREEN}+${added}${ANSI_RESET}`)
	if (removed > 0) parts.push(`${ANSI_RED}-${removed}${ANSI_RESET}`)
	return parts.join(" ")
}

function formatArgs(toolName: string, args: Record<string, unknown>): string {
	return (() => {
		switch (toolName) {
			case "read": {
				const path = String(args.path ?? "")
				const range =
					args.offset != null || args.limit != null
						? ` [${args.offset ?? 0}..${args.limit != null ? Number(args.offset ?? 0) + Number(args.limit) : ""}]`
						: ""
				return path + range
			}
			case "edit":
			case "write":
				return String(args.path ?? "")
			case "grep": {
				const pattern = String(args.pattern ?? "")
				const path = String(args.path ?? "")
				const include = args.include ? ` --include=${args.include}` : ""
				return `${pattern} ${path}${include}`.trim()
			}
			case "find":
				return `${String(args.pattern ?? "")} ${String(args.path ?? "")}`.trim()
			case "ls":
				return String(args.path ?? ".")
			default:
				return JSON.stringify(args)
		}
	})()
}

function formatSummary(toolName: string, content: string, isError: boolean, theme: Theme): string {
	if (isError) return content.split("\n")[0] || "error"
	const trimmed = content.replace(/\n+$/, "")
	const lines = trimmed ? trimmed.split("\n").length : 0
	switch (toolName) {
		case "edit":
			return diffSummary(content)
		case "write": {
			const writeLines = content ? content.split("\n").length : 0
			return theme.fg("dim", `${writeLines} line${writeLines === 1 ? "" : "s"} written`)
		}
		case "read":
		case "grep":
		case "ls":
			return theme.fg("dim", `${lines} line${lines === 1 ? "" : "s"} of output`)
		case "find":
			return theme.fg("dim", `${lines} file${lines === 1 ? "" : "s"} found`)
		default:
			return theme.fg("dim", "done")
	}
}

function buildBuiltinTool<TParams extends TSchema, TDetails>(
	factory: (cwd: string) => ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
	const meta = factory(process.cwd())
	return {
		...meta,
		execute(toolCallId, params, signal, onUpdate, ctx) {
			return factory(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx)
		},
		renderCall(args, theme, ctx) {
			const view = ctx.lastComponent instanceof ToolBlockView ? ctx.lastComponent : new ToolBlockView()
			buildToolCallHeader(view, meta.name, formatArgs(meta.name, args as Record<string, unknown>), theme, ctx)
			return view
		},
		renderResult(result, _options, theme, ctx) {
			const view = ctx.lastComponent instanceof ToolBlockView ? ctx.lastComponent : new ToolBlockView()
			const content = getTextContent(result)

			registerToolCall(ctx.toolCallId)
			view.setBranchMode((s) => theme.fg("borderMuted", s))

			const isDiff = meta.name === "edit" || meta.name === "write"

			if (isToolExpanded(ctx.toolCallId) && content) {
				if (isDiff && meta.name === "edit") {
					const colorized = colorizeDiff(content)
					view.setFooter("", "")
					view.setExtra(colorized.split("\n"))
				} else {
					view.setFooter(theme.fg("toolOutput", content), "")
					view.setExtra([])
				}
			} else {
				const summary = formatSummary(meta.name, content, ctx.isError, theme)
				const hint = ctx.isError ? "" : theme.fg("dim", "ctrl+o")
				view.setFooter(summary, hint)
				view.setExtra([])
			}

			return view
		},
	}
}

export default function toolRendererExtension(pi: ExtensionAPI) {
	pi.registerTool(buildBuiltinTool(createReadToolDefinition))
	pi.registerTool(buildBuiltinTool(createEditToolDefinition))
	pi.registerTool(buildBuiltinTool(createWriteToolDefinition))
	pi.registerTool(buildBuiltinTool(createGrepToolDefinition))
	pi.registerTool(buildBuiltinTool(createFindToolDefinition))
	pi.registerTool(buildBuiltinTool(createLsToolDefinition))
}
