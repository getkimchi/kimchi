import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildSubAgentSessionData, enrichSubAgentEntries, readTranscript } from "./export-subagents.js"

let tempDir: string

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "export-subagents-test-"))
})

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true })
})

describe("readTranscript", () => {
	it("reads a valid .output JSONL transcript", () => {
		const outputFile = join(tempDir, "agent-001.output")
		const entries = [
			{
				isSidechain: true,
				agentId: "agent-001",
				type: "user",
				message: { role: "user", content: "Explore the codebase" },
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/project",
			},
			{
				isSidechain: true,
				agentId: "agent-001",
				type: "assistant",
				message: { role: "assistant", content: [{ type: "text", text: "Found files" }] },
				timestamp: "2026-01-01T00:00:01.000Z",
				cwd: "/project",
			},
		]
		writeFileSync(outputFile, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`)

		const result = readTranscript(outputFile)
		expect(result).toHaveLength(2)
		expect(result[0].type).toBe("user")
		expect(result[1].type).toBe("assistant")
		expect(result[0].agentId).toBe("agent-001")
	})

	it("returns empty array for non-existent file", () => {
		expect(readTranscript(join(tempDir, "nonexistent.output"))).toEqual([])
	})

	it("skips malformed JSONL lines", () => {
		const outputFile = join(tempDir, "agent-002.output")
		writeFileSync(
			outputFile,
			`{"isSidechain":true,"agentId":"a","type":"user","message":{},"timestamp":"","cwd":""}\nNOT JSON\n{"isSidechain":true,"agentId":"a","type":"assistant","message":{},"timestamp":"","cwd":""}\n`,
		)

		const result = readTranscript(outputFile)
		expect(result).toHaveLength(2) // skips the "NOT JSON" line
	})

	it("skips entries without isSidechain flag", () => {
		const outputFile = join(tempDir, "agent-003.output")
		writeFileSync(
			outputFile,
			`{"isSidechain":true,"agentId":"a","type":"user","message":{},"timestamp":"","cwd":""}\n{"agentId":"a","type":"assistant","message":{}}\n`,
		)

		const result = readTranscript(outputFile)
		expect(result).toHaveLength(1) // only the first entry has isSidechain
	})
})

describe("enrichSubAgentEntries", () => {
	it("attaches transcript from outputFile to subagents:record entry", () => {
		const outputFile = join(tempDir, "agent-001.output")
		const transcriptEntries = [
			{
				isSidechain: true,
				agentId: "agent-001",
				type: "user" as const,
				message: { role: "user", content: "Explore the codebase" },
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/project",
			},
			{
				isSidechain: true,
				agentId: "agent-001",
				type: "assistant" as const,
				message: { role: "assistant", content: [{ type: "text", text: "Found files" }] },
				timestamp: "2026-01-01T00:00:01.000Z",
				cwd: "/project",
			},
		]
		writeFileSync(outputFile, `${transcriptEntries.map((e) => JSON.stringify(e)).join("\n")}\n`)

		const entries = [
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "hello" }] },
			},
			{
				type: "custom" as const,
				customType: "subagents:record",
				data: {
					id: "agent-001",
					type: "Explore",
					status: "completed",
					result: "Found files",
					outputFile,
					sessionFile: "/tmp/session.jsonl",
				},
			},
		]

		enrichSubAgentEntries(entries)

		const record = entries[1] as { data: { transcript?: unknown[]; outputFile?: string; sessionFile?: string } }
		expect(record.data.transcript).toHaveLength(2)
		expect(record.data.transcript?.[0]).toHaveProperty("type", "user")
		expect(record.data.transcript?.[1]).toHaveProperty("type", "assistant")
	})

	it("strips outputFile and sessionFile from export", () => {
		const entries = [
			{
				type: "custom" as const,
				customType: "subagents:record",
				data: {
					id: "agent-001",
					type: "Explore",
					status: "completed",
					result: "Done",
					outputFile: "/some/path/agent.output",
					sessionFile: "/some/path/session.jsonl",
				},
			},
		]

		enrichSubAgentEntries(entries)

		const record = entries[0] as { data: { outputFile?: string; sessionFile?: string } }
		expect(record.data.outputFile).toBeUndefined()
		expect(record.data.sessionFile).toBeUndefined()
	})

	it("handles missing outputFile gracefully", () => {
		const entries = [
			{
				type: "custom" as const,
				customType: "subagents:record",
				data: {
					id: "agent-001",
					type: "Explore",
					status: "completed",
					result: "Done",
				},
			},
		]

		// Should not throw
		enrichSubAgentEntries(entries)
		expect((entries[0] as { data: { transcript?: unknown[] } }).data.transcript).toBeUndefined()
	})

	it("handles non-existent outputFile file gracefully", () => {
		const entries = [
			{
				type: "custom" as const,
				customType: "subagents:record",
				data: {
					id: "agent-001",
					type: "Explore",
					status: "completed",
					result: "Done",
					outputFile: "/nonexistent/path/agent.output",
				},
			},
		]

		enrichSubAgentEntries(entries)
		expect((entries[0] as { data: { transcript?: unknown[] } }).data.transcript).toBeUndefined()
	})

	it("leaves non-subagents:record entries unchanged", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: [] } },
			{ type: "custom", customType: "trace_ids", data: { traceIds: ["abc"] } },
			{ type: "custom", customType: "config_changed", data: { key: "model" } },
		]

		const original = JSON.parse(JSON.stringify(entries))
		enrichSubAgentEntries(entries)
		expect(entries).toEqual(original)
	})

	it("rejects outputFile paths containing ..", () => {
		const entries = [
			{
				type: "custom" as const,
				customType: "subagents:record",
				data: {
					id: "agent-005",
					type: "Explore",
					status: "completed",
					outputFile: "/safe/dir/../../../etc/passwd",
				},
			},
		]

		enrichSubAgentEntries(entries)

		const record = entries[0] as { data: { transcript?: unknown[]; outputFile?: string } }
		expect(record.data.transcript).toBeUndefined()
		expect(record.data.outputFile).toBeUndefined()
	})

	it("rejects outputFile outside the provided baseDir", () => {
		const outputFile = join(tempDir, "agent-006.output")
		writeFileSync(outputFile, `{"isSidechain":true,"agentId":"a","type":"user","message":{},"timestamp":"","cwd":""}\n`)

		const entries = [
			{
				type: "custom" as const,
				customType: "subagents:record",
				data: {
					id: "agent-006",
					type: "Explore",
					status: "completed",
					outputFile,
				},
			},
		]

		// Pass a different directory as baseDir — the absolute outputFile is outside it.
		enrichSubAgentEntries(entries, "/some/other/dir")

		const record = entries[0] as { data: { transcript?: unknown[] } }
		expect(record.data.transcript).toBeUndefined()
	})

	it("accepts outputFile inside the provided baseDir", () => {
		const outputFile = join(tempDir, "agent-007.output")
		writeFileSync(outputFile, `{"isSidechain":true,"agentId":"a","type":"user","message":{},"timestamp":"","cwd":""}\n`)

		const entries = [
			{
				type: "custom" as const,
				customType: "subagents:record",
				data: {
					id: "agent-007",
					type: "Explore",
					status: "completed",
					outputFile,
				},
			},
		]

		enrichSubAgentEntries(entries, tempDir)

		const record = entries[0] as { data: { transcript?: unknown[] } }
		expect(record.data.transcript).toHaveLength(1)
	})

	it("preserves secret values verbatim in enriched transcript (redaction runs in a separate pass)", () => {
		const outputFile = join(tempDir, "agent-004.output")
		const transcriptEntries = [
			{
				isSidechain: true,
				agentId: "agent-004",
				type: "user",
				message: { role: "user", content: "Use API key [REDACTED-CASTAI_API_KEY]" },
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/project",
			},
		]
		writeFileSync(outputFile, `${transcriptEntries.map((e) => JSON.stringify(e)).join("\n")}\n`)

		const entries = [
			{
				type: "custom" as const,
				customType: "subagents:record",
				data: {
					id: "agent-004",
					type: "Explore",
					status: "completed",
					result: "Found key [REDACTED-CASTAI_API_KEY]",
					outputFile,
				},
			},
		]

		// Enrichment only — redactJsonlExport / redactHtmlExport run after this step.
		enrichSubAgentEntries(entries)

		const data = entries[0].data as unknown as {
			result: string
			transcript: Array<{ message: { content: string } }>
		}
		// Values pass through unchanged; the redaction pass is responsible for scrubbing.
		expect(data.result).toBe("Found key [REDACTED-CASTAI_API_KEY]")
		expect(data.transcript[0].message.content).toBe("Use API key [REDACTED-CASTAI_API_KEY]")
	})
})

describe("buildSubAgentSessionData", () => {
	it("returns systemPrompt as a top-level field for the upstream template", () => {
		const result = buildSubAgentSessionData({
			id: "agent-008",
			type: "Explore",
			status: "completed",
			systemPrompt: "You are an explorer. Be thorough.",
			transcript: [
				{
					isSidechain: true,
					agentId: "agent-008",
					type: "user",
					message: { role: "user", content: "Explore" },
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd: "/project",
				},
			],
		})

		expect(result.systemPrompt).toBe("You are an explorer. Be thorough.")
		expect(result.entries).toHaveLength(1)
		expect(result.entries[0]).toHaveProperty("type", "message")
	})

	it("does not inject a system prompt user message", () => {
		const result = buildSubAgentSessionData({
			id: "agent-009",
			type: "Explore",
			status: "completed",
			systemPrompt: "You are an explorer.",
			transcript: [],
		})

		const userMessages = result.entries.filter(
			(e) => e.type === "message" && (e.message as { role?: string }).role === "user",
		)
		expect(userMessages).toHaveLength(0)
	})

	it("falls back to persona config systemPrompt when record systemPrompt is missing", () => {
		const result = buildSubAgentSessionData({
			id: "agent-010",
			type: "Explore",
			status: "completed",
			transcript: [],
		})

		expect(result.systemPrompt).toBeTruthy()
		expect(typeof result.systemPrompt).toBe("string")
	})
})
