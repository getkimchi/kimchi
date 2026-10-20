import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { ARTIFACTS_ENTRY_TYPE, type ArtifactsEntry, artifactRecorderExtension } from "./recorder.js"

// Artifact recorder: one custom session entry per artifact-producing turn,
// so replay (any client) can re-emit exactly what live detected — stat-gated,
// capped, no re-derivation from raw output.

describe("artifact-recorder", () => {
	const cwd = mkdtempSync(join(tmpdir(), "artifact-recorder-"))
	beforeEach(() => mkdirSync(cwd, { recursive: true }))
	afterEach(() => rmSync(cwd, { recursive: true, force: true }))

	const ctx = { sessionManager: { getCwd: () => cwd } } as ExtensionContext

	const touch = (rel: string) => {
		const abs = join(cwd, rel)
		writeFileSync(abs, "x")
		return abs
	}

	it("records a row with detected artifacts after a turn with a write tool call", async () => {
		const abs = touch("out.md")
		const now = Date.now()
		const { api, emit, getAppendedEntries } = createExtensionApi()
		artifactRecorderExtension(api)
		await emit(
			"turn_end",
			{
				type: "turn_end",
				turnIndex: 0,
				message: {
					role: "assistant",
					timestamp: now,
					content: [{ type: "toolCall", id: "tc-1", name: "write", arguments: { path: "out.md" } }],
				},
				toolResults: [
					{
						toolCallId: "tc-1",
						toolName: "write",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: now,
					},
				],
			},
			ctx,
		)
		const rows = getAppendedEntries<ArtifactsEntry>(ARTIFACTS_ENTRY_TYPE)
		expect(rows).toHaveLength(1)
		expect(rows[0].v).toBe(1)
		expect(rows[0].artifacts).toEqual([{ path: abs, name: "out.md", mimeType: "text/markdown", sniffed: false }])
	})

	it("records nothing for a turn without tool calls (or user messages)", async () => {
		const { api, emit, getAppendedEntries } = createExtensionApi()
		artifactRecorderExtension(api)
		await emit(
			"turn_end",
			{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] },
			ctx,
		)
		await emit(
			"turn_end",
			{ type: "turn_end", turnIndex: 0, message: { role: "user", content: [] }, toolResults: [] },
			ctx,
		)
		expect(getAppendedEntries(ARTIFACTS_ENTRY_TYPE)).toHaveLength(0)
	})

	it("anchors the mtime window at the message (long-running call kept its early-written artifact)", async () => {
		const now = Date.now()
		// Artifact written 30s "before" the message (long-running call),
		// result lands now. A result-anchored window would drop it.
		const abs = touch("slow.md")
		utimesSync(abs, new Date(now - 30_000), new Date(now - 30_000))
		const { api, emit, getAppendedEntries } = createExtensionApi()
		artifactRecorderExtension(api)
		await emit(
			"turn_end",
			{
				type: "turn_end",
				turnIndex: 0,
				message: {
					role: "assistant",
					timestamp: now - 31_000,
					content: [{ type: "toolCall", id: "tc-1", name: "write", arguments: { path: "slow.md" } }],
				},
				toolResults: [
					{
						toolCallId: "tc-1",
						toolName: "write",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: now,
					},
				],
			},
			ctx,
		)
		expect(getAppendedEntries<ArtifactsEntry>(ARTIFACTS_ENTRY_TYPE)).toHaveLength(1)
	})

	it("records nothing when no detected artifact exists (live stat gate)", async () => {
		const now = Date.now()
		const { api, emit, getAppendedEntries } = createExtensionApi()
		artifactRecorderExtension(api)
		await emit(
			"turn_end",
			{
				type: "turn_end",
				turnIndex: 0,
				message: {
					role: "assistant",
					timestamp: now,
					content: [{ type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "echo hi" } }],
				},
				toolResults: [
					{
						toolCallId: "tc-1",
						toolName: "bash",
						content: [{ type: "text", text: "wednesday,elated,echo-baby.csv shipped" }],
						isError: false,
						timestamp: now,
					},
				],
			},
			ctx,
		)
		expect(getAppendedEntries(ARTIFACTS_ENTRY_TYPE)).toHaveLength(0)
	})

	it("keeps every intentional (write/edit) artifact; only sniffed bash entries cap at 32", async () => {
		const now = Date.now()
		const { api, emit, getAppendedEntries } = createExtensionApi()
		artifactRecorderExtension(api)
		const files = Array.from({ length: 40 }, (_, i) => `f${i}.md`)
		for (const f of files) touch(f)
		const blocks = files.map((f, i) => ({ type: "toolCall", id: `tc-${i}`, name: "write", arguments: { path: f } }))
		const results = files.map((_, i) => ({
			toolCallId: `tc-${i}`,
			toolName: "write",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: now,
		}))
		await emit(
			"turn_end",
			{
				type: "turn_end",
				turnIndex: 0,
				message: { role: "assistant", timestamp: now, content: blocks },
				toolResults: results,
			},
			ctx,
		)
		const rows = getAppendedEntries<ArtifactsEntry>(ARTIFACTS_ENTRY_TYPE)
		expect(rows).toHaveLength(1)
		// Writes are intentional and always land (live parity).
		expect(rows[0].artifacts).toHaveLength(40)
	})

	it("sniffed bash artifacts evict oldest past 32, intentional ones promote out", async () => {
		const now = Date.now()
		const { api, emit, getAppendedEntries } = createExtensionApi()
		artifactRecorderExtension(api)
		const files = Array.from({ length: 40 }, (_, i) => `s${i}.md`)
		for (const f of files) touch(f)
		// 40 bash results each mentioning its file…
		const bashResults = files.map((f, i) => ({
			toolCallId: `tcb-${i}`,
			toolName: "bash",
			content: [{ type: "text", text: `wrote ${f}` }],
			isError: false,
			timestamp: now,
		}))
		const writeResult = {
			toolCallId: "tcw-0",
			toolName: "write",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: now,
		}
		touch("plan.md")
		const blocks = [
			...files.map((f, i) => ({
				type: "toolCall",
				id: `tcb-${i}`,
				name: "bash",
				arguments: { command: `echo > ${f}` },
			})),
			{ type: "toolCall", id: "tcw-0", name: "write", arguments: { path: "plan.md" } },
		]
		await emit(
			"turn_end",
			{
				type: "turn_end",
				turnIndex: 0,
				message: { role: "assistant", timestamp: now, content: blocks },
				toolResults: [...bashResults, writeResult],
			},
			ctx,
		)
		const rows = getAppendedEntries<ArtifactsEntry>(ARTIFACTS_ENTRY_TYPE)
		expect(rows).toHaveLength(1)
		const names = rows[0].artifacts.map((a) => a.name)
		// 32 most-recent sniffed (s8..s39) plus the intentional write.
		expect(names).toHaveLength(33)
		expect(names).toContain("plan.md")
		expect(names).toContain("s39.md")
		expect(names).not.toContain("s0.md")
	})

	it("round-trip URI can be rebuilt from the recorded row (replay assumption)", () => {
		const abs = join(cwd, "a.md")
		expect(pathToFileURL(abs).href).toContain("a.md")
	})
})
