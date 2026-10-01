import type {
	SessionUpdate,
	ToolCall,
	ToolCallContent,
	ToolCallLocation,
	ToolCallStatus,
	ToolKind,
} from "@agentclientprotocol/sdk"
import { asString, truncate } from "../utils.js"

// Mirrors the tool names kimchi actually exposes: pi-coding-agent core tools
// plus the kimchi extensions in src/extensions (web-fetch, web-search, Agent).
// ACP clients key UI affordances (icon, grouping, permission messaging) off the
// kind field, so every registered tool should map to the most specific kind in
// the ToolKind vocabulary before falling back to "other". MCP tools arrive with
// dynamic `mcp__server__name` identifiers we can't enumerate statically — those
// still hit the "other" fallback in describeToolCall().
const TOOL_KINDS: Record<string, ToolKind> = {
	bash: "execute",
	powershell: "execute",
	read: "read",
	ls: "read",
	grep: "search",
	find: "search",
	edit: "edit",
	write: "edit",
	web_fetch: "fetch",
	web_search: "search",
	Agent: "think",
}

// Title extraction is per-tool, not arg-shape detection. The previous version
// treated any tool with a `path`/`file_path`/`command`/`pattern` argument as if
// that argument were the title, so non-file tools (lsp_*, debug_*, daemon, …)
// showed a raw argument in place of the tool name. Only the tools listed here
// get an argument-derived title; everything else falls back to the tool name.
// Legacy alias first: providers historically emit `file_path` (the original
// pre-refactor precedence), schema-conformant `path` as fallback.
const TITLE_ARGS: Record<string, string[]> = {
	bash: ["command"],
	powershell: ["command"],
	read: ["file_path", "path"],
	write: ["file_path", "path"],
	edit: ["file_path", "path"],
	ls: ["path"],
	grep: ["pattern"],
	find: ["pattern"],
	web_fetch: ["url"],
	web_search: ["query"],
	memory_search: ["query"],
	Agent: ["description"],
}

// Only these tools report their target path via ACP `locations` (clients render
// a file chip from it). grep/find accept an optional search-scope `path`, so
// they participate too. It must never leak to tools that merely have a
// path-shaped argument.
const LOCATION_TOOLS = new Set(["read", "write", "edit", "ls", "grep", "find"])

export function describeToolCall(
	toolName: string,
	args: unknown,
): { title: string; kind: ToolKind; locations: ToolCallLocation[] } {
	const a = (args ?? {}) as Record<string, unknown>
	const titleArgNames = TITLE_ARGS[toolName] ?? []
	const targeted = titleArgNames.map((key) => asString(a[key])).find((v) => !!v)
	// title carries the target/argument only; the ACP `kind` field drives the verb
	// and icon on the client side. Truncate so a long absolute path or regex
	// doesn't blow up client UIs (locations[].path keeps the full value for
	// clients that want it).
	const rawTitle = targeted ?? toolName
	const locationPath = LOCATION_TOOLS.has(toolName) ? asString(a.file_path) || asString(a.path) : undefined
	return {
		title: truncate(rawTitle, 80),
		kind: TOOL_KINDS[toolName] ?? "other",
		locations: locationPath ? [{ path: locationPath }] : [],
	}
}

export function isHiddenToolCall(toolName: string, args: unknown): boolean {
	// Defense-in-depth: the Agent tool's public schema deliberately omits `visibility`
	// (see src/extensions/agents/index.ts:execute), so this normally returns false. If a
	// misbehaving LLM emits the field anyway, we hide the ACP-side tool_call rather than
	// trust the schema to have caught it.
	if (toolName !== "Agent") return false
	const a = (args ?? {}) as Record<string, unknown>
	return typeof a.visibility === "string" && a.visibility.toLowerCase() === "system"
}

type ToolCallFields = {
	toolName: string
	toolCallId: string
	piToolCallId: string
	status: ToolCallStatus
	rawInput: Record<string, unknown>
	_meta?: Record<string, unknown>
}

/**
 * Build the bare ToolCall shape (no `sessionUpdate` discriminant).
 *
 * `session/request_permission` carries a `ToolCallUpdate`, which has no
 * `sessionUpdate` field — passing a session-notification object there puts an
 * out-of-schema key on the wire.
 */
export function buildToolCallShape({ toolName, piToolCallId, rawInput, ...params }: ToolCallFields): ToolCall {
	const { title, kind, locations } = describeToolCall(toolName, rawInput)
	return {
		title,
		kind,
		locations,
		rawInput,
		...params,
		_meta: { piToolCallId, ...params._meta },
	}
}

export function buildToolCall(fields: ToolCallFields): SessionUpdate {
	return { sessionUpdate: "tool_call", ...buildToolCallShape(fields) }
}

type ToolCallUpdateFields = {
	toolCallId: string
	piToolCallId: string
	status: ToolCallStatus
	title?: string
	kind?: ToolKind
	locations?: ToolCallLocation[]
	content?: ToolCallContent[]
	rawInput?: Record<string, unknown>
	rawOutput?: Record<string, unknown>
	_meta?: Record<string, unknown>
}
export function buildToolCallUpdate({ piToolCallId, ...params }: ToolCallUpdateFields): SessionUpdate {
	return {
		sessionUpdate: "tool_call_update",
		...params,
		_meta: { piToolCallId, ...(params._meta ?? {}) },
	}
}
