import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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
		expect(rows[0].artifacts).toEqual([{ path: abs, name: "out.md", mimeType: "text/markdown" }])
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

	it("caps recorded artifacts per turn", async () => {
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
		expect(rows[0].artifacts).toHaveLength(32)
	})

	it("round-trip URI can be rebuilt from the recorded row (replay assumption)", () => {
		const abs = join(cwd, "a.md")
		expect(pathToFileURL(abs).href).toContain("a.md")
	})
})
