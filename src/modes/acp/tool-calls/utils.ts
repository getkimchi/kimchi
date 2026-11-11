import { isAbsolute, resolve } from "node:path"

import type {
	SessionUpdate,
	ToolCall,
	ToolCallContent,
	ToolCallLocation,
	ToolCallStatus,
	ToolKind,
} from "@agentclientprotocol/sdk"
import {
	elapsedSecondsSince,
	type ProcessDisplaySnapshot,
	type ProcessRegistry,
	summarizeCommand,
} from "../../../extensions/bash-background/process-registry.js"
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

// Which argument becomes the title, per kind-mapped tool. Keyed on
// TOOL_KINDS so a kind "other" tool can never get an argument-derived
// title — those always title with the tool name. `file_path` first is
// historical precedence; `path` is the schema-conformant alias.
const TITLE_ARGS: Record<keyof typeof TOOL_KINDS, string[]> = {
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
	Agent: ["description"],
}

export function describeToolCall(
	toolName: string,
	args: unknown,
	cwd?: string,
	bashControlRegistry?: ProcessRegistry,
): { title: string; kind: ToolKind; locations: ToolCallLocation[] } {
	const a = (args ?? {}) as Record<string, unknown>
	const titleArgNames = TITLE_ARGS[toolName] ?? []
	const targeted = asString(a[titleArgNames[0] ?? ""]) ?? asString(a[titleArgNames[1] ?? ""])
	// bash_control names what it blocks on: resolve its args against the live
	// process registry. Unknown/stale handles resolve to nothing and keep the
	// tool-name fallback below.
	const bashControlTitle =
		toolName === "bash_control" && bashControlRegistry ? describeBashControlTitle(a, bashControlRegistry) : undefined
	// title carries the target/argument only; the ACP `kind` field drives the verb
	// and icon on the client side. Truncate so a long absolute path or regex
	// doesn't blow up client UIs (locations[].path keeps the full value for
	// clients that want it).
	const rawTitle = bashControlTitle ?? targeted ?? toolName
	const path = asString(a.file_path) || asString(a.path)
	// ACP requires locations[].path to be absolute (clients resolve it against
	// their own view of the filesystem, not our session cwd). Models regularly
	// hand tools cwd-relative paths ("README.md"), which the tools resolve
	// against the session cwd — do the same here before putting it on the wire.
	const resolvedPath = path && cwd && !isAbsolute(path) ? resolve(cwd, path) : path
	return {
		title: truncate(rawTitle, 80),
		kind: TOOL_KINDS[toolName] ?? "other",
		locations: resolvedPath ? [{ path: resolvedPath }] : [],
	}
}

/**
 * Human title for a `bash_control` call resolved against the live process
 * registry: names the command(s) it waits on or stops, with elapsed seconds.
 * A cohort-wide wait (`wait: true`, no handles) names the running cohort.
 * Returns undefined when nothing resolves, so callers keep the plain
 * tool-name fallback for unknown or stale handles.
 */
export function describeBashControlTitle(args: Record<string, unknown>, registry: ProcessRegistry): string | undefined {
	const mentioned = new Set<string>()
	for (const key of ["stop_handles", "handles"] as const) {
		const value = args[key]
		if (Array.isArray(value)) for (const h of value) if (typeof h === "string" && h.length > 0) mentioned.add(h)
	}
	// Legacy `{ handle, action }` payloads degrade to an inspection in the
	// tool, but still name the process they refer to for the title.
	if (typeof args.handle === "string" && args.handle.length > 0) mentioned.add(args.handle)
	const snapshots = new Map<string, ProcessDisplaySnapshot>()
	for (const handle of mentioned) {
		const snapshot = registry.displaySnapshot(handle)
		if (snapshot) snapshots.set(handle, snapshot)
	}
	if (snapshots.size === 0 && args.wait === true) {
		for (const snapshot of registry.listDisplaySnapshots())
			if (snapshot.state === "running") snapshots.set(snapshot.handle, snapshot)
	}
	if (snapshots.size === 0) return undefined
	const verb =
		args.wait === true
			? "Waiting for background process"
			: Array.isArray(args.stop_handles) && args.stop_handles.length > 0
				? "Stopping background process"
				: "Checking background process"
	const entries = [...snapshots.values()]
		.sort((x, y) => x.startedAt - y.startedAt)
		.map((s) => `${summarizeCommand(s.command, 48)} · ${elapsedSecondsSince(s.startedAt)}s`)
	return `${verb}: ${entries.join(", ")}`
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
	cwd?: string
	bashControlRegistry?: ProcessRegistry
	_meta?: Record<string, unknown>
}

/**
 * Build the bare ToolCall shape (no `sessionUpdate` discriminant).
 *
 * `session/request_permission` carries a `ToolCallUpdate`, which has no
 * `sessionUpdate` field — passing a session-notification object there puts an
 * out-of-schema key on the wire.
 */
export function buildToolCallShape({
	toolName,
	piToolCallId,
	rawInput,
	cwd,
	bashControlRegistry,
	...params
}: ToolCallFields): ToolCall {
	const { title, kind, locations } = describeToolCall(toolName, rawInput, cwd, bashControlRegistry)
	return {
		title,
		kind,
		locations,
		rawInput,
		name: toolName,
		...params,
		// kind "other" tools (e.g. bash_control) reuse the title slot for a
		// human label; the spec-native name field keeps the tool identity
		// recoverable for clients that key behavior off it.
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
	toolName?: string
	title?: string
	kind?: ToolKind
	locations?: ToolCallLocation[]
	content?: ToolCallContent[]
	rawInput?: Record<string, unknown>
	rawOutput?: Record<string, unknown>
	_meta?: Record<string, unknown>
}
export function buildToolCallUpdate({ piToolCallId, toolName, ...params }: ToolCallUpdateFields): SessionUpdate {
	return {
		sessionUpdate: "tool_call_update",
		...params,
		...(toolName ? { name: toolName } : {}),
		_meta: { piToolCallId, ...(params._meta ?? {}) },
	}
}
