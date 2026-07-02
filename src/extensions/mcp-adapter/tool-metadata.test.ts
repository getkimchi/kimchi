/**
 * Unit tests for `buildToolMetadata` and `isReadOnlyMcpTool`.
 *
 * Verifies that the live fetch path carries an MCP tool's `annotations`
 * through to the resulting `ToolMetadata` — specifically that a tool
 * annotated `{ readOnlyHint: true }` survives with that hint intact, and
 * that un-annotated tools surface `annotations === undefined`.
 *
 * Also verifies the `isReadOnlyMcpTool` predicate: annotated read tools
 * return true, un-annotated tools whose name matches the read-only heuristic
 * prefixes (`get_`, `search_`, `list_`, `read_`, `fetch_`) return true, and
 * explicit write tools (`readOnlyHint: false`) or non-matching names return
 * false.
 */
import { describe, expect, it } from "vitest"
import { buildToolMetadata, isReadOnlyMcpTool } from "./tool-metadata.js"
import type { McpTool } from "./types.js"

const SERVER_NAME = "testserver"
const DEFINITION = {}

describe("buildToolMetadata — annotations", () => {
	it("preserves readOnlyHint:true on an annotated tool", () => {
		const tools: McpTool[] = [
			{
				name: "get_record",
				description: "Fetch a record",
				annotations: { readOnlyHint: true },
			},
		]

		const { metadata } = buildToolMetadata(tools, [], DEFINITION, SERVER_NAME, "server")

		expect(metadata).toHaveLength(1)
		expect(metadata[0].originalName).toBe("get_record")
		expect(metadata[0].annotations).toBeDefined()
		expect(metadata[0].annotations?.readOnlyHint).toBe(true)
	})

	it("surfaces annotations === undefined for an un-annotated tool", () => {
		const tools: McpTool[] = [
			{
				name: "create_record",
				description: "Create a record",
			},
		]

		const { metadata } = buildToolMetadata(tools, [], DEFINITION, SERVER_NAME, "server")

		expect(metadata).toHaveLength(1)
		expect(metadata[0].annotations).toBeUndefined()
	})

	it("preserves a destructiveHint annotation alongside readOnlyHint", () => {
		const tools: McpTool[] = [
			{
				name: "delete_record",
				description: "Delete a record",
				annotations: { readOnlyHint: false, destructiveHint: true },
			},
		]

		const { metadata } = buildToolMetadata(tools, [], DEFINITION, SERVER_NAME, "server")

		expect(metadata[0].annotations?.readOnlyHint).toBe(false)
		expect(metadata[0].annotations?.destructiveHint).toBe(true)
	})
})

describe("isReadOnlyMcpTool", () => {
	it("returns true for an annotated read tool (readOnlyHint:true)", () => {
		expect(
			isReadOnlyMcpTool({
				originalName: "get_issue",
				annotations: { readOnlyHint: true },
			}),
		).toBe(true)
	})

	it("returns true for an un-annotated tool matching the get_ heuristic", () => {
		expect(isReadOnlyMcpTool({ originalName: "get_issue" })).toBe(true)
	})

	it("returns true for un-annotated tools matching other heuristic prefixes", () => {
		expect(isReadOnlyMcpTool({ originalName: "search_records" })).toBe(true)
		expect(isReadOnlyMcpTool({ originalName: "list_projects" })).toBe(true)
		expect(isReadOnlyMcpTool({ originalName: "read_file" })).toBe(true)
		expect(isReadOnlyMcpTool({ originalName: "fetch_status" })).toBe(true)
	})

	it("returns false for an explicit write tool (readOnlyHint:false)", () => {
		expect(
			isReadOnlyMcpTool({
				originalName: "update_issue",
				annotations: { readOnlyHint: false },
			}),
		).toBe(false)
	})

	it("returns false for an un-annotated tool with a non-matching name", () => {
		expect(isReadOnlyMcpTool({ originalName: "create_issue" })).toBe(false)
		expect(isReadOnlyMcpTool({ originalName: "delete_issue" })).toBe(false)
	})

	it("returns false for a read-prefixed name when annotations mark it as write", () => {
		// The heuristic only applies when annotations are absent; an explicit
		// readOnlyHint:false must win even for a get_-prefixed name.
		expect(
			isReadOnlyMcpTool({
				originalName: "get_secret",
				annotations: { readOnlyHint: false },
			}),
		).toBe(false)
	})
})
