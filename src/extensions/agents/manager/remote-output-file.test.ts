import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AcpSessionCallbacks } from "../../../sandbox/worker/acp-client.js"
import { streamRemoteToOutputFile } from "./remote-output-file.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "remote-output-file-"))
}

function readJsonl(path: string): Record<string, unknown>[] {
	const raw = readFileSync(path, "utf-8")
	return raw
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l))
}

interface EntryContent {
	type: string
	name?: string
	id?: string
	text?: string
	input?: unknown
}

interface ParsedEntry {
	type: string
	message: { role: string; content: EntryContent[] }
}

function parseEntries(entries: Record<string, unknown>[]): ParsedEntry[] {
	return entries as unknown as ParsedEntry[]
}

function findToolUseEntry(entries: ParsedEntry[]): ParsedEntry | undefined {
	return entries.find((e) => e.type === "assistant" && e.message.content?.some((c) => c.type === "tool_use"))
}

function findToolUseEntries(entries: ParsedEntry[]): ParsedEntry[] {
	return entries.filter((e) => e.type === "assistant" && e.message.content?.some((c) => c.type === "tool_use"))
}

function findTextEntry(entries: ParsedEntry[]): ParsedEntry | undefined {
	return entries.find((e) => e.type === "assistant" && e.message.content?.some((c) => c.type === "text"))
}

function findToolResultEntry(entries: ParsedEntry[]): ParsedEntry | undefined {
	return entries.find((e) => e.type === "toolResult")
}

function getToolUseContent(entry: ParsedEntry): EntryContent {
	const toolUse = entry.message.content.find((c) => c.type === "tool_use")
	if (!toolUse) throw new Error("tool_use content not found in entry")
	return toolUse
}

function getTextContent(entry: ParsedEntry): EntryContent {
	const text = entry.message.content.find((c) => c.type === "text")
	if (!text) throw new Error("text content not found in entry")
	return text
}

/** Builds a tool_call SessionNotification with the given fields. */
function toolCallNotification(
	toolCallId: string,
	title: string,
	status: string,
	extra: Partial<{ rawInput: unknown; rawOutput: unknown }> = {},
): SessionNotification {
	return {
		sessionId: "session-abc",
		update: {
			sessionUpdate: "tool_call",
			toolCallId,
			title,
			status,
			...(extra.rawInput != null ? { rawInput: extra.rawInput } : {}),
			...(extra.rawOutput != null ? { rawOutput: extra.rawOutput } : {}),
		},
	} as unknown as SessionNotification
}

function toolCallUpdateNotification(
	toolCallId: string,
	extra: Partial<{ title: string; status: string; rawInput: unknown; rawOutput: unknown }> = {},
): SessionNotification {
	return {
		sessionId: "session-abc",
		update: {
			sessionUpdate: "tool_call_update",
			toolCallId,
			...(extra.title != null ? { title: extra.title } : {}),
			...(extra.status != null ? { status: extra.status } : {}),
			...(extra.rawInput != null ? { rawInput: extra.rawInput } : {}),
			...(extra.rawOutput != null ? { rawOutput: extra.rawOutput } : {}),
		},
	} as unknown as SessionNotification
}

/** Minimal inner callbacks that record activity. */
function makeInnerCallbacks(): { callbacks: AcpSessionCallbacks; activities: string[] } {
	const activities: string[] = []
	const callbacks: AcpSessionCallbacks = {
		onToolActivity: (a: { status: string; toolName: string }) => activities.push(`${a.status}:${a.toolName}`),
		onTextDelta: vi.fn(),
		onTurnEnd: vi.fn(),
	}
	return { callbacks, activities }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("streamRemoteToOutputFile", () => {
	let tmp: string
	let outputPath: string

	beforeEach(() => {
		tmp = makeTmpDir()
		outputPath = join(tmp, "transcript.jsonl")
	})

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true })
	})

	describe("tool_use id and name", () => {
		it("uses the actual toolCallId for the tool_use id, not the display title", () => {
			const { callbacks: inner, activities } = makeInnerCallbacks()
			const { callbacks, setOutputPath } = streamRemoteToOutputFile(inner, "/cwd")
			setOutputPath(outputPath, "agent-1")

			// Simulate: raw notification with toolCallId arrives first
			callbacks.onRawNotification?.(
				toolCallNotification("call-123", "Reading file.ts", "in_progress", {
					rawInput: { path: "/app/file.ts" },
				}),
			)
			// Then onToolActivity start fires
			callbacks.onToolActivity?.({ status: "in_progress", toolName: "Reading file.ts" })
			// Tool completes
			callbacks.onRawNotification?.(
				toolCallUpdateNotification("call-123", { status: "completed", rawOutput: "file contents" }),
			)
			callbacks.onToolActivity?.({ status: "completed", toolName: "Reading file.ts" })
			// Turn end to flush
			callbacks.onTurnEnd?.(1)

			const entries = parseEntries(readJsonl(outputPath))
			const toolUseEntry = findToolUseEntry(entries)
			expect(toolUseEntry).toBeDefined()
			const toolUse = getToolUseContent(toolUseEntry as ParsedEntry)
			expect(toolUse.id).toBe("call-123")
			expect(toolUse.name).toBe("Reading file.ts")
			expect(activities).toContain("in_progress:Reading file.ts")
			expect(activities).toContain("completed:Reading file.ts")
		})

		it("uses the toolCallId that arrives in a later update, before completion", () => {
			const { callbacks: inner } = makeInnerCallbacks()
			const { callbacks, setOutputPath } = streamRemoteToOutputFile(inner, "/cwd")
			setOutputPath(outputPath, "agent-1")

			// onToolActivity fires before any raw notification with toolCallId
			callbacks.onToolActivity?.({ status: "in_progress", toolName: "Shell command" })
			// The toolCallId arrives in the completion update — because the
			// tool_use entry is written at completion, it picks up this id.
			callbacks.onRawNotification?.(toolCallUpdateNotification("call-456", { status: "completed", rawOutput: "done" }))
			callbacks.onToolActivity?.({ status: "completed", toolName: "Shell command" })
			callbacks.onTurnEnd?.(1)

			const entries = parseEntries(readJsonl(outputPath))
			const toolUseEntry = findToolUseEntry(entries)
			expect(toolUseEntry).toBeDefined()
			const toolUse = getToolUseContent(toolUseEntry as ParsedEntry)
			expect(toolUse.id).toBe("call-456")
		})

		it("falls back to toolName for id when no toolCallId ever arrives", () => {
			const { callbacks: inner } = makeInnerCallbacks()
			const { callbacks, setOutputPath } = streamRemoteToOutputFile(inner, "/cwd")
			setOutputPath(outputPath, "agent-1")

			// Activity-only flow — no raw notifications carry a toolCallId.
			callbacks.onToolActivity?.({ status: "in_progress", toolName: "Shell command" })
			callbacks.onToolActivity?.({ status: "completed", toolName: "Shell command" })
			callbacks.onTurnEnd?.(1)

			const entries = parseEntries(readJsonl(outputPath))
			const toolUseEntry = findToolUseEntry(entries)
			expect(toolUseEntry).toBeDefined()
			const toolUse = getToolUseContent(toolUseEntry as ParsedEntry)
			expect(toolUse.id).toBe("Shell command")
		})

		it("correlates tool_use and tool_result by the same toolCallId", () => {
			const { callbacks: inner } = makeInnerCallbacks()
			const { callbacks, setOutputPath } = streamRemoteToOutputFile(inner, "/cwd")
			setOutputPath(outputPath, "agent-1")

			callbacks.onRawNotification?.(
				toolCallNotification("call-789", "Editing file.ts", "in_progress", {
					rawInput: { path: "/app/file.ts" },
				}),
			)
			callbacks.onToolActivity?.({ status: "in_progress", toolName: "Editing file.ts" })
			callbacks.onRawNotification?.(
				toolCallUpdateNotification("call-789", { status: "completed", rawOutput: { success: true } }),
			)
			callbacks.onToolActivity?.({ status: "completed", toolName: "Editing file.ts" })
			callbacks.onTurnEnd?.(1)

			const entries = parseEntries(readJsonl(outputPath))
			const toolUseEntry = findToolUseEntry(entries)
			const toolResultEntry = findToolResultEntry(entries)

			expect(toolUseEntry).toBeDefined()
			expect(toolResultEntry).toBeDefined()
			// The tool_use id should be call-789
			const toolUse = getToolUseContent(toolUseEntry as ParsedEntry)
			expect(toolUse.id).toBe("call-789")
		})
	})

	describe("flush behavior", () => {
		it("writes assistant text on turn end", () => {
			const { callbacks: inner } = makeInnerCallbacks()
			const { callbacks, setOutputPath } = streamRemoteToOutputFile(inner, "/cwd")
			setOutputPath(outputPath, "agent-1")

			callbacks.onTextDelta?.("Hello ", "Hello ")
			callbacks.onTextDelta?.("world", "Hello world")
			callbacks.onTurnEnd?.(1)

			const entries = parseEntries(readJsonl(outputPath))
			const textEntry = findTextEntry(entries)
			expect(textEntry).toBeDefined()
			const textBlock = getTextContent(textEntry as ParsedEntry)
			expect(textBlock.text).toBe("Hello world")
		})

		it("flushRemaining flushes buffered assistant text on abort", () => {
			const { callbacks: inner } = makeInnerCallbacks()
			const { callbacks, setOutputPath, flushRemaining } = streamRemoteToOutputFile(inner, "/cwd")
			setOutputPath(outputPath, "agent-1")

			// Stream some text — not yet flushed (no turn end)
			callbacks.onTextDelta?.("Partial response", "Partial response")

			// Simulate abort — flushRemaining should persist the buffered text
			flushRemaining()

			const entries = parseEntries(readJsonl(outputPath))
			const textEntry = findTextEntry(entries)
			expect(textEntry).toBeDefined()
			const textBlock = getTextContent(textEntry as ParsedEntry)
			expect(textBlock.text).toBe("Partial response")
		})

		it("flushRemaining flushes a pending in-progress tool call on abort", () => {
			const { callbacks: inner } = makeInnerCallbacks()
			const { callbacks, setOutputPath, flushRemaining } = streamRemoteToOutputFile(inner, "/cwd")
			setOutputPath(outputPath, "agent-1")

			// Start a tool call but never get an "end" event
			callbacks.onRawNotification?.(
				toolCallNotification("call-abort", "Reading file.ts", "in_progress", {
					rawInput: { path: "/app/file.ts" },
				}),
			)
			callbacks.onToolActivity?.({ status: "in_progress", toolName: "Reading file.ts" })

			// Abort before tool completes
			flushRemaining()

			const entries = parseEntries(readJsonl(outputPath))
			// Should have the tool_use entry
			const toolUseEntry = findToolUseEntry(entries)
			expect(toolUseEntry).toBeDefined()
			// Should also have a toolResult entry (flushed as incomplete)
			const toolResultEntry = findToolResultEntry(entries)
			expect(toolResultEntry).toBeDefined()
		})

		it("buffers entries before setOutputPath and writes them after path is set", () => {
			const { callbacks: inner } = makeInnerCallbacks()
			const { callbacks, setOutputPath } = streamRemoteToOutputFile(inner, "/cwd")

			// Events arrive before setOutputPath — should be buffered, not dropped
			callbacks.onTextDelta?.("early text", "early text")
			callbacks.onTurnEnd?.(1)

			// No file written yet — flush guards on outputPath
			expect(() => readFileSync(outputPath, "utf-8")).toThrow()

			// After setOutputPath, a subsequent flush writes the buffered entries
			setOutputPath(outputPath, "agent-1")
			callbacks.onTextDelta?.("more text", "more text")
			callbacks.onTurnEnd?.(2)

			const entries = parseEntries(readJsonl(outputPath))
			// Both turns should be present — the first was buffered, the second written immediately
			expect(entries.length).toBe(2)
			const texts = entries.map((e) => getTextContent(e).text)
			expect(texts).toContain("early text")
			expect(texts).toContain("more text")
		})
	})

	describe("rawInput handling", () => {
		it("captures rawInput from tool_call_update that arrives after start", () => {
			const { callbacks: inner } = makeInnerCallbacks()
			const { callbacks, setOutputPath } = streamRemoteToOutputFile(inner, "/cwd")
			setOutputPath(outputPath, "agent-1")

			// tool_call with no rawInput, just status in_progress
			callbacks.onRawNotification?.(toolCallNotification("call-late", "Late input tool", "in_progress"))
			callbacks.onToolActivity?.({ status: "in_progress", toolName: "Late input tool" })

			// rawInput arrives in a tool_call_update
			callbacks.onRawNotification?.(
				toolCallUpdateNotification("call-late", {
					status: "completed",
					rawInput: { command: "ls -la" },
					rawOutput: "file1.txt",
				}),
			)
			callbacks.onToolActivity?.({ status: "completed", toolName: "Late input tool" })
			callbacks.onTurnEnd?.(1)

			const entries = parseEntries(readJsonl(outputPath))
			const toolUseEntry = findToolUseEntry(entries)
			expect(toolUseEntry).toBeDefined()
			const toolUse = getToolUseContent(toolUseEntry as ParsedEntry)
			// The tool_use entry is written once, at completion — so args that
			// streamed in after start are included.
			expect(toolUse.input).toEqual({ command: "ls -la" })
		})

		it("captures rawInput from tool_call notification when it arrives before start", () => {
			const { callbacks: inner } = makeInnerCallbacks()
			const { callbacks, setOutputPath } = streamRemoteToOutputFile(inner, "/cwd")
			setOutputPath(outputPath, "agent-1")

			callbacks.onRawNotification?.(
				toolCallNotification("call-early", "Early input tool", "in_progress", {
					rawInput: { path: "/app/file.ts" },
				}),
			)
			callbacks.onToolActivity?.({ status: "in_progress", toolName: "Early input tool" })
			callbacks.onRawNotification?.(
				toolCallUpdateNotification("call-early", { status: "completed", rawOutput: "contents" }),
			)
			callbacks.onToolActivity?.({ status: "completed", toolName: "Early input tool" })
			callbacks.onTurnEnd?.(1)

			const entries = parseEntries(readJsonl(outputPath))
			const toolUseEntry = findToolUseEntry(entries)
			expect(toolUseEntry).toBeDefined()
			const toolUse = getToolUseContent(toolUseEntry as ParsedEntry)
			expect(toolUse.input).toEqual({ path: "/app/file.ts" })
		})
	})

	describe("repeated in_progress dedup", () => {
		it("writes a single tool_use entry despite repeated in_progress heartbeats", () => {
			// Regression: cloud agents broadcast identical in_progress
			// notifications for the same toolCallId periodically (~80ms) while a
			// long-running tool executes. Each repeat used to append another
			// assistant tool_use entry — a 30-minute nested Agent call produced
			// ~5,800 identical lines and a 29MB .output file.
			const { callbacks: inner } = makeInnerCallbacks()
			const { callbacks, setOutputPath } = streamRemoteToOutputFile(inner, "/cwd")
			setOutputPath(outputPath, "agent-1")

			const args = { description: "Build Chunk 3 quiz polish", prompt: "You are building Chunk 3…" }
			callbacks.onRawNotification?.(toolCallNotification("kt.Agent.8", "Agent", "in_progress", { rawInput: args }))
			callbacks.onToolActivity?.({ status: "in_progress", toolName: "Agent", toolCallId: "kt.Agent.8" })

			// Heartbeat: the server re-broadcasts the same in_progress activity
			// (with identical args) many times while the tool runs.
			for (let i = 0; i < 50; i++) {
				callbacks.onRawNotification?.(
					toolCallUpdateNotification("kt.Agent.8", { status: "in_progress", rawInput: args }),
				)
				callbacks.onToolActivity?.({ status: "in_progress", toolName: "Agent", toolCallId: "kt.Agent.8" })
			}

			callbacks.onRawNotification?.(
				toolCallUpdateNotification("kt.Agent.8", { status: "completed", rawOutput: "done" }),
			)
			callbacks.onToolActivity?.({ status: "completed", toolName: "Agent", toolCallId: "kt.Agent.8" })
			callbacks.onTurnEnd?.(1)

			const entries = parseEntries(readJsonl(outputPath))
			const toolUseEntries = findToolUseEntries(entries)
			expect(toolUseEntries).toHaveLength(1)
			const toolUse = getToolUseContent(toolUseEntries[0])
			expect(toolUse.id).toBe("kt.Agent.8")
			expect(toolUse.name).toBe("Agent")
			expect(toolUse.input).toEqual(args)
			expect(entries.filter((e) => e.type === "toolResult")).toHaveLength(1)
		})

		it("keeps the latest streamed rawInput in the single tool_use entry", () => {
			const { callbacks: inner } = makeInnerCallbacks()
			const { callbacks, setOutputPath } = streamRemoteToOutputFile(inner, "/cwd")
			setOutputPath(outputPath, "agent-1")

			// Args stream in across repeated in_progress notifications: partial
			// first, complete later.
			callbacks.onRawNotification?.(toolCallNotification("call-stream", "Shell command", "in_progress"))
			callbacks.onToolActivity?.({ status: "in_progress", toolName: "Shell command" })
			callbacks.onRawNotification?.(
				toolCallUpdateNotification("call-stream", { status: "in_progress", rawInput: { command: "ls" } }),
			)
			callbacks.onToolActivity?.({ status: "in_progress", toolName: "Shell command" })
			callbacks.onRawNotification?.(
				toolCallUpdateNotification("call-stream", { status: "in_progress", rawInput: { command: "ls -la" } }),
			)
			callbacks.onToolActivity?.({ status: "in_progress", toolName: "Shell command" })
			callbacks.onRawNotification?.(toolCallUpdateNotification("call-stream", { status: "completed", rawOutput: "ok" }))
			callbacks.onToolActivity?.({ status: "completed", toolName: "Shell command" })
			callbacks.onTurnEnd?.(1)

			const entries = parseEntries(readJsonl(outputPath))
			const toolUseEntries = findToolUseEntries(entries)
			expect(toolUseEntries).toHaveLength(1)
			const toolUse = getToolUseContent(toolUseEntries[0])
			expect(toolUse.input).toEqual({ command: "ls -la" })
		})

		it("writes one tool_use entry per completed tool call across sequential calls with the same name", () => {
			const { callbacks: inner } = makeInnerCallbacks()
			const { callbacks, setOutputPath } = streamRemoteToOutputFile(inner, "/cwd")
			setOutputPath(outputPath, "agent-1")

			for (const id of ["call-1", "call-2", "call-3"]) {
				callbacks.onRawNotification?.(toolCallNotification(id, "Shell command", "in_progress"))
				callbacks.onToolActivity?.({ status: "in_progress", toolName: "Shell command", toolCallId: id })
				callbacks.onToolActivity?.({ status: "in_progress", toolName: "Shell command", toolCallId: id })
				callbacks.onRawNotification?.(toolCallUpdateNotification(id, { status: "completed", rawOutput: "ok" }))
				callbacks.onToolActivity?.({ status: "completed", toolName: "Shell command", toolCallId: id })
			}
			callbacks.onTurnEnd?.(1)

			const entries = parseEntries(readJsonl(outputPath))
			const toolUseIds = findToolUseEntries(entries).map((e) => getToolUseContent(e).id)
			expect(toolUseIds).toEqual(["call-1", "call-2", "call-3"])
			expect(entries.filter((e) => e.type === "toolResult")).toHaveLength(3)
		})
	})

	describe("distinct pending tool calls", () => {
		it("finalizes a pending call with a degraded result when a different call starts before it completes", () => {
			// ACP turns can run parallel tool calls (or a call may be abandoned):
			// in_progress B arrives while A is still pending. A must keep its own
			// entry — its id must not end up paired with B's title, and B's entry
			// must be written separately.
			const { callbacks: inner } = makeInnerCallbacks()
			const { callbacks, setOutputPath } = streamRemoteToOutputFile(inner, "/cwd")
			setOutputPath(outputPath, "agent-1")

			callbacks.onRawNotification?.(toolCallNotification("call-a", "Tool A", "in_progress", { rawInput: { a: 1 } }))
			callbacks.onToolActivity?.({ status: "in_progress", toolName: "Tool A", toolCallId: "call-a" })
			callbacks.onRawNotification?.(toolCallNotification("call-b", "Tool B", "in_progress"))
			callbacks.onToolActivity?.({ status: "in_progress", toolName: "Tool B", toolCallId: "call-b" })
			callbacks.onRawNotification?.(toolCallUpdateNotification("call-b", { status: "in_progress", rawInput: { b: 2 } }))
			// A completes after it was already finalized — an orphan completion
			// for the now-pending B's slot; its rawOutput must not attach to B
			// and no third entry may be written.
			callbacks.onRawNotification?.(toolCallUpdateNotification("call-a", { status: "completed", rawOutput: "a out" }))
			callbacks.onToolActivity?.({ status: "completed", toolName: "Tool A", toolCallId: "call-a" })
			callbacks.onRawNotification?.(toolCallUpdateNotification("call-b", { status: "completed", rawOutput: "b out" }))
			callbacks.onToolActivity?.({ status: "completed", toolName: "Tool B", toolCallId: "call-b" })
			callbacks.onTurnEnd?.(1)

			const entries = parseEntries(readJsonl(outputPath))
			const toolUses = findToolUseEntries(entries).map((e) => getToolUseContent(e))
			expect(toolUses.map((t) => t.id)).toEqual(["call-a", "call-b"])
			expect(toolUses[0].name).toBe("Tool A")
			expect(toolUses[0].input).toEqual({ a: 1 })
			expect(toolUses[1].name).toBe("Tool B")
			expect(toolUses[1].input).toEqual({ b: 2 })

			const results = entries.filter((e) => e.type === "toolResult").map((e) => getTextContent(e).text)
			expect(results).toHaveLength(2)
			expect(results[0]).toBe("Tool A") // degraded placeholder for the finalized call
			expect(results[1]).toBe('"b out"') // B's own real output, not A's late one
		})

		it("does not leak the previous call's rawInput into a call that streamed no args", () => {
			const { callbacks: inner } = makeInnerCallbacks()
			const { callbacks, setOutputPath } = streamRemoteToOutputFile(inner, "/cwd")
			setOutputPath(outputPath, "agent-1")

			callbacks.onRawNotification?.(
				toolCallNotification("call-1", "Shell command", "in_progress", { rawInput: { command: "ls" } }),
			)
			callbacks.onToolActivity?.({ status: "in_progress", toolName: "Shell command", toolCallId: "call-1" })
			callbacks.onRawNotification?.(toolCallUpdateNotification("call-1", { status: "completed", rawOutput: "ok" }))
			callbacks.onToolActivity?.({ status: "completed", toolName: "Shell command", toolCallId: "call-1" })

			callbacks.onRawNotification?.(toolCallNotification("call-2", "Shell command", "in_progress"))
			callbacks.onToolActivity?.({ status: "in_progress", toolName: "Shell command", toolCallId: "call-2" })
			callbacks.onRawNotification?.(toolCallUpdateNotification("call-2", { status: "completed", rawOutput: "ok" }))
			callbacks.onToolActivity?.({ status: "completed", toolName: "Shell command", toolCallId: "call-2" })
			callbacks.onTurnEnd?.(1)

			const entries = parseEntries(readJsonl(outputPath))
			const toolUses = findToolUseEntries(entries).map((e) => getToolUseContent(e))
			expect(toolUses).toHaveLength(2)
			expect(toolUses[0].input).toEqual({ command: "ls" })
			expect(toolUses[1].input).toEqual({})
		})
	})

	describe("in_progress forwarding dedup", () => {
		it("forwards repeated in_progress notifications for the same toolCallId only once to the tracker", () => {
			const { callbacks: inner, activities } = makeInnerCallbacks()
			const { callbacks, setOutputPath } = streamRemoteToOutputFile(inner, "/cwd")
			setOutputPath(outputPath, "agent-1")

			// The ACP server re-sends in_progress for the same call as args/title
			// stream in — the tracker must only ever see one per tool call, or the
			// progress line stacks duplicates ("run_command, run_command, …").
			callbacks.onToolActivity?.({ status: "in_progress", toolName: "run_command", toolCallId: "kt.run_command.1" })
			callbacks.onToolActivity?.({
				status: "in_progress",
				toolName: "run_command",
				toolCallId: "kt.run_command.1",
				title: "cd /home && curl -sS https://example.com",
			})
			callbacks.onToolActivity?.({ status: "in_progress", toolName: "run_command", toolCallId: "kt.run_command.1" })
			expect(activities.filter((a) => a === "in_progress:run_command")).toHaveLength(1)

			// A second concurrent tool call is forwarded independently.
			callbacks.onToolActivity?.({ status: "in_progress", toolName: "read_file", toolCallId: "kt.read_file.2" })
			expect(activities.filter((a) => a === "in_progress:read_file")).toHaveLength(1)

			// Completion clears the dedup guard — a subsequent call forwards again.
			callbacks.onToolActivity?.({ status: "completed", toolName: "run_command", toolCallId: "kt.run_command.1" })
			callbacks.onToolActivity?.({ status: "in_progress", toolName: "run_command", toolCallId: "kt.run_command.1" })
			expect(activities.filter((a) => a === "in_progress:run_command")).toHaveLength(2)
		})
	})

	describe("text slicing (textOffset / lastFullTextLength)", () => {
		it("passes full text through before the first tool call", () => {
			const { callbacks: inner } = makeInnerCallbacks()
			const onTextDelta = vi.mocked(inner.onTextDelta)
			const { callbacks, setOutputPath } = streamRemoteToOutputFile(inner, "/cwd")
			setOutputPath(outputPath, "agent-1")

			callbacks.onTextDelta?.("Hello ", "Hello ")
			callbacks.onTextDelta?.("world", "Hello world")

			expect(onTextDelta).toHaveBeenNthCalledWith(1, "Hello ", "Hello ")
			expect(onTextDelta).toHaveBeenNthCalledWith(2, "world", "Hello world")
		})

		it("slices post-tool deltas from the offset set at tool completion", () => {
			const { callbacks: inner } = makeInnerCallbacks()
			const onTextDelta = vi.mocked(inner.onTextDelta)
			const { callbacks, setOutputPath } = streamRemoteToOutputFile(inner, "/cwd")
			setOutputPath(outputPath, "agent-1")

			callbacks.onTextDelta?.("", "Before the tool.")
			callbacks.onRawNotification?.(toolCallNotification("call-1", "Reading file.ts", "in_progress"))
			callbacks.onToolActivity?.({ status: "in_progress", toolName: "Reading file.ts" })
			callbacks.onRawNotification?.(toolCallUpdateNotification("call-1", { status: "completed", rawOutput: "ok" }))
			callbacks.onToolActivity?.({ status: "completed", toolName: "Reading file.ts" })

			// ACP sends full accumulated text — only post-tool text should pass through
			callbacks.onTextDelta?.("After", "Before the tool.After")

			expect(onTextDelta).toHaveBeenLastCalledWith("After", "After")
		})

		it("resets the offset on turn end", () => {
			const { callbacks: inner } = makeInnerCallbacks()
			const onTextDelta = vi.mocked(inner.onTextDelta)
			const { callbacks, setOutputPath } = streamRemoteToOutputFile(inner, "/cwd")
			setOutputPath(outputPath, "agent-1")

			callbacks.onTextDelta?.("", "turn one text")
			callbacks.onRawNotification?.(toolCallNotification("call-1", "Reading file.ts", "in_progress"))
			callbacks.onToolActivity?.({ status: "in_progress", toolName: "Reading file.ts" })
			callbacks.onToolActivity?.({ status: "completed", toolName: "Reading file.ts" })
			callbacks.onTurnEnd?.(1)

			// New turn: full fresh text passes through unsliced
			callbacks.onTextDelta?.("New ", "New ")
			callbacks.onTextDelta?.("turn", "New turn")

			expect(onTextDelta).toHaveBeenNthCalledWith(2, "New ", "New ")
			expect(onTextDelta).toHaveBeenNthCalledWith(3, "turn", "New turn")
		})
	})

	describe("resetForReattach", () => {
		it("discards pending assistant text and zeroes offsets so fresh full text passes through", () => {
			const { callbacks: inner } = makeInnerCallbacks()
			const onTextDelta = vi.mocked(inner.onTextDelta)
			const { callbacks, setOutputPath, resetForReattach } = streamRemoteToOutputFile(inner, "/cwd")
			setOutputPath(outputPath, "agent-1")

			// Pre-disconnect: accumulated text + an offset from a completed tool
			callbacks.onTextDelta?.("", "Before the tool.")
			callbacks.onRawNotification?.(toolCallNotification("call-1", "Reading file.ts", "in_progress"))
			callbacks.onToolActivity?.({ status: "in_progress", toolName: "Reading file.ts" })
			callbacks.onRawNotification?.(toolCallUpdateNotification("call-1", { status: "completed", rawOutput: "ok" }))
			callbacks.onToolActivity?.({ status: "completed", toolName: "Reading file.ts" })
			callbacks.onTextDelta?.("partial", "Before the tool.partial")

			resetForReattach()

			// The pre-disconnect partial is NOT flushed: the post-reattach recovery
			// backfills the complete remote entries from session.jsonl, and a
			// reattach-time flush would stamp them with the local clock and
			// corrupt the backfill's dedup boundary.
			const entries = parseEntries(readJsonl(outputPath))
			const texts = entries
				.filter((e) => e.message.content.some((c) => c.type === "text"))
				.map((e) => getTextContent(e).text)
			expect(texts).toContain("Before the tool.")
			expect(texts).not.toContain("Before the tool.partial")

			// Post-reattach: the fresh client restarts accumulation — full fresh
			// text arrives and must pass through unsliced (no stale offset).
			callbacks.onTextDelta?.("fresh ", "fresh ")
			callbacks.onTextDelta?.("start", "fresh start")
			expect(onTextDelta).toHaveBeenLastCalledWith("start", "fresh start")
		})

		it("discards a pending in-progress tool call — the backfill restores the real result", () => {
			const { callbacks: inner } = makeInnerCallbacks()
			const { callbacks, setOutputPath, resetForReattach } = streamRemoteToOutputFile(inner, "/cwd")
			setOutputPath(outputPath, "agent-1")

			callbacks.onRawNotification?.(
				toolCallNotification("call-x", "Reading file.ts", "in_progress", { rawInput: { path: "/app/f.ts" } }),
			)
			callbacks.onToolActivity?.({ status: "in_progress", toolName: "Reading file.ts" })

			resetForReattach()

			// Tool tracking is cleared — the next tool call starts clean
			callbacks.onRawNotification?.(toolCallNotification("call-y", "New tool", "in_progress"))
			callbacks.onToolActivity?.({ status: "in_progress", toolName: "New tool" })
			callbacks.onRawNotification?.(toolCallUpdateNotification("call-y", { status: "completed", rawOutput: "ok" }))
			callbacks.onToolActivity?.({ status: "completed", toolName: "New tool" })
			callbacks.onTurnEnd?.(2)

			const after = parseEntries(readJsonl(outputPath))
			// No degraded title-only toolResult was written for the discarded
			// pre-disconnect tool call — the recovery backfill supplies the tool's
			// real output from session.jsonl.
			expect(findToolResultEntry(after)).toBeDefined()
			// Only the post-reattach tool call is present locally
			const toolUseEntries = findToolUseEntries(after)
			expect(toolUseEntries).toHaveLength(1)
			expect(getToolUseContent(toolUseEntries[0]).id).toBe("call-y")
		})

		it("keeps outputPath and agentId (subsequent flushes still write)", () => {
			const { callbacks: inner } = makeInnerCallbacks()
			const { callbacks, setOutputPath, resetForReattach } = streamRemoteToOutputFile(inner, "/cwd")
			setOutputPath(outputPath, "agent-1")

			callbacks.onTextDelta?.("pre", "pre")
			resetForReattach()
			callbacks.onTextDelta?.("post", "post")
			callbacks.onTurnEnd?.(1)

			const entries = parseEntries(readJsonl(outputPath))
			const texts = entries.map((e) => getTextContent(e).text)
			// The pre-disconnect "pre" text is discarded (the backfill restores the
			// complete remote entry); only post-reattach entries are written.
			expect(texts).not.toContain("pre")
			expect(texts).toContain("post")
			for (const e of readJsonl(outputPath)) {
				expect(e.agentId).toBe("agent-1")
			}
		})
	})
})
