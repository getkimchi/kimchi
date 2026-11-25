import { describe, expect, it } from "vitest"
import { type ExportEntry, injectTraceIdsIntoEntries, injectTraceIdsIntoExport } from "./trace-id-export.js"

describe("injectTraceIdsIntoExport", () => {
	it("injects traceIds from trace_ids custom entry into its parent message entry", () => {
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/local" }),
			JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hello" } }),
			JSON.stringify({ type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: "hi" } }),
			JSON.stringify({
				type: "custom",
				id: "t1",
				parentId: "e2",
				customType: "trace_ids",
				data: { traceIds: ["trace-abc"] },
			}),
		]
		const result = injectTraceIdsIntoExport(lines)
		const parentEntry = JSON.parse(result[2])
		expect(parentEntry.traceIds).toEqual(["trace-abc"])
		expect(JSON.parse(result[3]).customType).toBe("trace_ids")
	})

	it("walks parent chain past tool_result to land trace IDs on the assistant message", () => {
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/local" }),
			JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "use a tool" } }),
			JSON.stringify({
				type: "message",
				id: "e2",
				parentId: "e1",
				message: { role: "assistant", content: "using tool" },
			}),
			JSON.stringify({ type: "tool_use", id: "tool1", parentId: "e2", data: { name: "bash" } }),
			JSON.stringify({ type: "tool_result", id: "res1", parentId: "tool1", data: { output: "ok" } }),
			JSON.stringify({
				type: "custom",
				id: "t1",
				parentId: "res1",
				customType: "trace_ids",
				data: { traceIds: ["trace-through-tool"] },
			}),
		]
		const result = injectTraceIdsIntoExport(lines)
		const assistantEntry = JSON.parse(result[2])
		expect(assistantEntry.traceIds).toEqual(["trace-through-tool"])
		expect(JSON.parse(result[4]).traceIds).toBeUndefined()
		expect(JSON.parse(result[5]).customType).toBe("trace_ids")
	})

	it("deduplicates when multiple trace_ids entries target the same parent", () => {
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/local" }),
			JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hello" } }),
			JSON.stringify({ type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: "hi" } }),
			JSON.stringify({
				type: "custom",
				id: "t1",
				parentId: "e2",
				customType: "trace_ids",
				data: { traceIds: ["trace-a", "trace-b"] },
			}),
			JSON.stringify({
				type: "custom",
				id: "t2",
				parentId: "e2",
				customType: "trace_ids",
				data: { traceIds: ["trace-b", "trace-c"] },
			}),
		]
		const result = injectTraceIdsIntoExport(lines)
		const parentEntry = JSON.parse(result[2])
		expect(parentEntry.traceIds).toEqual(["trace-a", "trace-b", "trace-c"])
	})

	it("returns lines unchanged when there are no trace_ids entries", () => {
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/local" }),
			JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hello" } }),
			JSON.stringify({ type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: "hi" } }),
		]
		const result = injectTraceIdsIntoExport(lines)
		expect(result).toEqual(lines)
	})
})

describe("injectTraceIdsIntoEntries", () => {
	it("injects traceIds into the immediate parent when it is an assistant message", () => {
		const entries: ExportEntry[] = [
			{ id: "e1", parentId: null, type: "message", message: { role: "user", content: "hello" } },
			{ id: "e2", parentId: "e1", type: "message", message: { role: "assistant", content: "hi" } },
			{ id: "t1", parentId: "e2", type: "custom", customType: "trace_ids", data: { traceIds: ["trace-abc"] } },
		]
		const result = injectTraceIdsIntoEntries(entries)
		const assistantEntry = result[1]
		expect(assistantEntry.traceIds).toEqual(["trace-abc"])
		expect(result[2].customType).toBe("trace_ids")
	})

	it("walks parent chain past tool_result to find the assistant message", () => {
		const entries: ExportEntry[] = [
			{ id: "e1", parentId: null, type: "message", message: { role: "user", content: "use a tool" } },
			{ id: "e2", parentId: "e1", type: "message", message: { role: "assistant", content: "using tool" } },
			{ id: "tool1", parentId: "e2", type: "tool_use", data: { name: "bash" } },
			{ id: "res1", parentId: "tool1", type: "tool_result", data: { output: "ok" } },
			{
				id: "t1",
				parentId: "res1",
				type: "custom",
				customType: "trace_ids",
				data: { traceIds: ["trace-through-tool"] },
			},
		]
		const result = injectTraceIdsIntoEntries(entries)
		const assistantEntry = result[1]
		expect(assistantEntry.traceIds).toEqual(["trace-through-tool"])
		expect(result[3].traceIds).toBeUndefined()
	})

	it("walks deeply nested parent chain to find the assistant message", () => {
		const entries: ExportEntry[] = [
			{ id: "u1", parentId: null, type: "message", message: { role: "user", content: "do complex thing" } },
			{ id: "a1", parentId: "u1", type: "message", message: { role: "assistant", content: "complex" } },
			{ id: "s1", parentId: "a1", type: "thinking", data: { text: "thinking" } },
			{ id: "s2", parentId: "s1", type: "step", data: { text: "step" } },
			{ id: "t1", parentId: "s2", type: "custom", customType: "trace_ids", data: { traceIds: ["trace-deep"] } },
		]
		const result = injectTraceIdsIntoEntries(entries)
		const assistantEntry = result[1]
		expect(assistantEntry.traceIds).toEqual(["trace-deep"])
	})

	it("deduplicates when multiple trace_ids entries target the same assistant message", () => {
		const entries: ExportEntry[] = [
			{ id: "e1", parentId: null, type: "message", message: { role: "user", content: "hello" } },
			{ id: "e2", parentId: "e1", type: "message", message: { role: "assistant", content: "hi" } },
			{ id: "t1", parentId: "e2", type: "custom", customType: "trace_ids", data: { traceIds: ["trace-a", "trace-b"] } },
			{ id: "t2", parentId: "e2", type: "custom", customType: "trace_ids", data: { traceIds: ["trace-b", "trace-c"] } },
		]
		const result = injectTraceIdsIntoEntries(entries)
		const assistantEntry = result[1]
		expect(assistantEntry.traceIds).toEqual(["trace-a", "trace-b", "trace-c"])
	})

	it("returns entries unchanged when there are no trace_ids entries", () => {
		const entries: ExportEntry[] = [
			{ id: "e1", parentId: null, type: "message", message: { role: "user", content: "hello" } },
			{ id: "e2", parentId: "e1", type: "message", message: { role: "assistant", content: "hi" } },
		]
		const result = injectTraceIdsIntoEntries(entries)
		expect(result).toEqual(entries)
	})

	it("does nothing when parent chain has no assistant message", () => {
		const entries: ExportEntry[] = [
			{ id: "e1", parentId: null, type: "message", message: { role: "user", content: "hello" } },
			{ id: "t1", parentId: "e1", type: "custom", customType: "trace_ids", data: { traceIds: ["trace-orphan"] } },
		]
		const result = injectTraceIdsIntoEntries(entries)
		expect(result[1].traceIds).toBeUndefined()
	})
})
