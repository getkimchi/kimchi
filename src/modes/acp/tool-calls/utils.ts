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
): { title: string; kind: ToolKind; locations: ToolCallLocation[] } {
	const a = (args ?? {}) as Record<string, unknown>
	const titleArgNames = TITLE_ARGS[toolName] ?? []
	const targeted = asString(a[titleArgNames[0] ?? ""]) ?? asString(a[titleArgNames[1] ?? ""])
	// title carries the target/argument only; the ACP `kind` field drives the verb
	// and icon on the client side. Truncate so a long absolute path or regex
	// doesn't blow up client UIs (locations[].path keeps the full value for
	// clients that want it).
	const rawTitle = targeted ?? toolName
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
 * Registry-resolved payload for a `bash_control` call that names the
 * background process(es) it waits on or stops, plus how long the
 * longest-running of them has been going. A cohort-wide wait (`wait: true`,
 * no handles) resolves the running cohort — but only when the call did not
 * name inspection `handles`: the tool rejects `wait: true` + `handles` as
 * invalid-params, so resolving that call against the whole cohort would
 * mislabel an erroring call. Returns undefined when nothing resolves
 * (unknown or stale handles, empty cohort), so callers keep the plain args
 * untouched.
 */

/** One registry-resolved background process behind a bash_control call;
 * startedAt is ISO 8601 for readability on the wire. */
export type BashControlBackgroundCommand = { command: string; startedAt: string }

export function resolveBashControlWaitInfo(
	args: Record<string, unknown>,
	registry: ProcessRegistry,
): { commands: BashControlBackgroundCommand[]; elapsedSeconds: number } | undefined {
	const mentioned = new Set<string>()
	for (const key of ["stop_handles", "handles"] as const) {
		const value = args[key]
		if (Array.isArray(value)) for (const h of value) if (typeof h === "string" && h.length > 0) mentioned.add(h)
	}
	// Legacy `{ handle, action }` payloads degrade to an inspection in the
	// tool, but still name the process they refer to.
	if (typeof args.handle === "string" && args.handle.length > 0) mentioned.add(args.handle)
	const snapshots = new Map<string, ProcessDisplaySnapshot>()
	for (const handle of mentioned) {
		const snapshot = registry.displaySnapshot(handle)
		if (snapshot) snapshots.set(handle, snapshot)
	}
	// The tool rejects `wait: true` whenever `handles` is present (even an
	// empty or blank-only array), so ANY `handles` key pins this call to what
	// it names; only a handle-less wait may fall back to the running cohort.
	const namesInspectionHandles = Array.isArray(args.handles)
	if (snapshots.size === 0 && args.wait === true && !namesInspectionHandles) {
		for (const snapshot of registry.listDisplaySnapshots())
			if (snapshot.state === "running") snapshots.set(snapshot.handle, snapshot)
	}
	if (snapshots.size === 0) return undefined
	// Earliest-started first: it is the longest-running of the cohort, so its
	// elapsed seconds headline the wait.
	const entries = [...snapshots.values()].sort((x, y) => x.startedAt - y.startedAt)
	// Elapsed headlines the longest-running LIVE process; for a terminal-only
	// set it reports the actual lifetime, never a ticking since-started value
	// that would read as the uptime of a process that already finished.
	const runningEntries = entries.filter((s) => s.state === "running")
	const elapsedHead = runningEntries[0] ?? entries[0]
	return {
		commands: entries.map((s) => ({
			command: summarizeCommand(s.command, 48),
			startedAt: new Date(s.startedAt).toISOString(),
		})),
		elapsedSeconds: snapshotElapsedSeconds(elapsedHead),
	}
}

/**
 * Seconds a process has been going: elapsed since spawn while it runs, its
 * actual lifetime (`finishedAt - startedAt`) once it is terminal. Snapshots
 * without a recorded finish (registry tests, legacy mocks) degrade to the
 * observation time, mirroring the pre-cap behavior.
 */
function snapshotElapsedSeconds(snapshot: ProcessDisplaySnapshot): number {
	const end = snapshot.state === "running" ? Date.now() : (snapshot.finishedAt ?? snapshot.observedAt ?? Date.now())
	return Math.max(0, Math.floor((end - snapshot.startedAt) / 1000))
}

/** Flat tool-call _meta key carrying the registry-resolved cohort behind a `bash_control` call (waits most of all). */
export const BASH_CONTROL_WAIT_META_KEY = "bashControlWait"

/** Transcript custom-entry type recording a completed wait's targets. */
export const BASH_CONTROL_WAIT_TARGETS_ENTRY_TYPE = "bash-control-wait-targets"

/** Data persisted under BASH_CONTROL_WAIT_TARGETS_ENTRY_TYPE — the cohort a completed bash_control resolved for its wait. No elapsedSeconds: a finished wait has no running clock. */
export interface BashControlWaitTargetsData {
	toolCallId: string
	commands: BashControlBackgroundCommand[]
}

/**
 * Registry-resolved info behind a `bash_control` call, as a flat `_meta`
 * fragment (the same flat shape piToolCallId and other tool-call meta
 * use). rawInput is never touched — it MUST stay exactly what the agent
 * wrote; live session state is metadata by definition. Returns undefined
 * for other tools, a missing registry, or when nothing resolves, so
 * callers can leave _meta absent rather than emit empties.
 */
export function bashControlWaitMeta(
	toolName: string,
	rawInput: Record<string, unknown>,
	registry?: ProcessRegistry,
): Record<string, unknown> | undefined {
	if (toolName !== "bash_control" || !registry) return undefined
	const info = resolveBashControlWaitInfo(rawInput, registry)
	if (!info) return undefined
	return { [BASH_CONTROL_WAIT_META_KEY]: info }
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
	const { title, kind, locations } = describeToolCall(toolName, rawInput, cwd)
	return {
		title,
		kind,
		locations,
		rawInput,
		...params,
		_meta: {
			...bashControlWaitMeta(toolName, rawInput, bashControlRegistry),
			piToolCallId,
			...params._meta,
		},
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
