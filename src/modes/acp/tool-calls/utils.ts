import type {
	SessionUpdate,
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

export function describeToolCall(
	toolName: string,
	args: unknown,
): { title: string; kind: ToolKind; locations: ToolCallLocation[] } {
	const a = (args ?? {}) as Record<string, unknown>
	const path = asString(a.file_path) ?? asString(a.path)
	const command = asString(a.command)
	const pattern = asString(a.pattern)
	// title carries the target/argument only; the ACP `kind` field drives the verb
	// and icon on the client side. Bash puts its command here; file ops put the
	// path; search ops put the pattern. Falls back to the tool name when we have
	// no specific argument to show. Truncate every branch so a long absolute
	// path or regex doesn't blow up client UIs (locations[].path keeps the full
	// value for clients that want it).
	const rawTitle = toolName === "bash" && command ? command : (path ?? pattern ?? toolName)
	return {
		title: truncate(rawTitle, 80),
		kind: TOOL_KINDS[toolName] ?? "other",
		locations: path ? [{ path }] : [],
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
	status?: ToolCallStatus
	rawInput: Record<string, unknown>
	_meta?: Record<string, unknown>
}
export function buildToolCall({ toolName, piToolCallId, rawInput, ...params }: ToolCallFields): SessionUpdate {
	const { title, kind, locations } = describeToolCall(toolName, rawInput)
	return {
		sessionUpdate: "tool_call",
		status: "pending",
		title,
		kind,
		locations,
		rawInput,
		...params,
		_meta: { piToolCallId, ...params._meta },
	}
}

type ToolCallUpdateFields = {
	toolCallId: string
	piToolCallId: string
	title?: string
	kind?: ToolKind
	locations?: ToolCallLocation[]
	status?: ToolCallStatus
	content?: ToolCallContent[]
	rawInput?: Record<string, unknown>
	rawOutput?: Record<string, unknown>
	_meta?: Record<string, unknown>
}
export function buildToolCallUpdate({ piToolCallId, ...params }: ToolCallUpdateFields): SessionUpdate {
	return {
		sessionUpdate: "tool_call_update",
		status: "in_progress",
		...params,
		_meta: { piToolCallId, ...(params._meta ?? {}) },
	}
}
