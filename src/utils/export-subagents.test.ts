import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { enrichSubAgentEntries, readTranscript } from "./export-subagents.js"

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

	it("preserves secret values verbatim in enriched transcript (redaction owned by PR #800)", () => {
		const outputFile = join(tempDir, "agent-004.output")
		const transcriptEntries = [
			{
				isSidechain: true,
				agentId: "agent-004",
				type: "user",
				message: { role: "user", content: "Use API key castai_v1_leaked_secret" },
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
					result: "Found key castai_v1_in_result",
					outputFile,
				},
			},
		]

		// Enrichment only — secret redaction is now owned by PR #800's
		// redactJsonlExport / redactHtmlExport, which run after this step.
		enrichSubAgentEntries(entries)

		const data = entries[0].data as unknown as {
			result: string
			transcript: Array<{ message: { content: string } }>
		}
		// Values pass through unchanged; PR #800 is responsible for scrubbing.
		expect(data.result).toBe("Found key castai_v1_in_result")
		expect(data.transcript[0].message.content).toBe("Use API key castai_v1_leaked_secret")
	})
})
