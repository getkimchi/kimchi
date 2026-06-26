/**
 * Unit tests for the cache annotation round-trip.
 *
 * Verifies that `serializeTools` → `reconstructToolMetadata` preserves an
 * MCP tool's `annotations`:
 *   - A tool annotated `{ readOnlyHint: true }` round-trips with that hint
 *     intact on the reconstructed `ToolMetadata`.
 *   - A tool with no `annotations` reconstructs with `annotations === undefined`.
 *
 * This covers the cache serialize→reconstruct path that backs both the proxy
 * tool path and the direct-tools cached-metadata construction.
 */
import { describe, expect, it } from "vitest"
import { reconstructToolMetadata, serializeTools } from "./metadata-cache.js"
import type { ServerCacheEntry } from "./metadata-cache.js"
import type { McpTool } from "./types.js"

const SERVER_NAME = "testserver"

function reconstruct(serialized: ReturnType<typeof serializeTools>): ServerCacheEntry {
	return {
		configHash: "deadbeef",
		tools: serialized,
		resources: [],
		cachedAt: Date.now(),
	}
}

describe("cache annotation round-trip (serializeTools → reconstructToolMetadata)", () => {
	it("preserves readOnlyHint:true through serialize → reconstruct", () => {
		const tools: McpTool[] = [
			{
				name: "get_record",
				description: "Fetch a record",
				annotations: { readOnlyHint: true },
			},
		]

		const serialized = serializeTools(tools)
		// Sanity: the CachedTool carries annotations.
		expect(serialized[0].annotations?.readOnlyHint).toBe(true)

		const [reconstructed] = reconstructToolMetadata(SERVER_NAME, reconstruct(serialized), "server", {})

		expect(reconstructed.originalName).toBe("get_record")
		expect(reconstructed.annotations).toBeDefined()
		expect(reconstructed.annotations?.readOnlyHint).toBe(true)
	})

	it("reconstructs annotations === undefined for an un-annotated tool", () => {
		const tools: McpTool[] = [
			{
				name: "create_record",
				description: "Create a record",
			},
		]

		const serialized = serializeTools(tools)
		// Sanity: the CachedTool has no annotations key.
		expect(serialized[0].annotations).toBeUndefined()

		const [reconstructed] = reconstructToolMetadata(SERVER_NAME, reconstruct(serialized), "server", {})

		expect(reconstructed.originalName).toBe("create_record")
		expect(reconstructed.annotations).toBeUndefined()
	})

	it("round-trips a destructive write tool's annotations", () => {
		const tools: McpTool[] = [
			{
				name: "delete_record",
				description: "Delete a record",
				annotations: { readOnlyHint: false, destructiveHint: true },
			},
		]

		const serialized = serializeTools(tools)
		const [reconstructed] = reconstructToolMetadata(SERVER_NAME, reconstruct(serialized), "server", {})

		expect(reconstructed.annotations?.readOnlyHint).toBe(false)
		expect(reconstructed.annotations?.destructiveHint).toBe(true)
	})
})
