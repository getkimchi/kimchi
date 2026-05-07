/**
 * Map of tool name → tool argument type, for the typed `tool<TName>` overload.
 *
 * Two sources:
 * - Pi-coding-agent built-ins (`bash`, `read`, ...) — listed in
 *   `BUILTIN_TOOL_NAMES`, smoke-tested against pi-coding-agent's per-tool
 *   create functions.
 * - Kimchi-bundled custom tools (`web_fetch`, `web_search`) — declared
 *   locally; the harness owns these so types live next to the matchers that
 *   use them.
 *
 * Unknown tool names fall through to the untyped overload of `tool(...)`.
 */

import type {
	BashToolInput,
	EditToolInput,
	FindToolInput,
	GrepToolInput,
	LsToolInput,
	ReadToolInput,
	WriteToolInput,
} from "@mariozechner/pi-coding-agent"

export interface BuiltinToolArgs {
	bash: BashToolInput
	read: ReadToolInput
	edit: EditToolInput
	write: WriteToolInput
	grep: GrepToolInput
	find: FindToolInput
	ls: LsToolInput
}

export interface WebFetchToolInput {
	url: string
	format?: "markdown" | "text" | "html"
	timeout?: number
}

export interface WebSearchToolInput {
	query: string
	recency?: "day" | "week" | "month" | "year"
	search_depth?: "basic" | "deep"
	max_content_chars?: number
}

export interface KimchiToolArgs {
	web_fetch: WebFetchToolInput
	web_search: WebSearchToolInput
}

export type ToolArgs = BuiltinToolArgs & KimchiToolArgs

export type KnownToolName = keyof ToolArgs

export const BUILTIN_TOOL_NAMES: readonly (keyof BuiltinToolArgs)[] = [
	"bash",
	"read",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
]
