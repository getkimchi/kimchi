import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { McpAnnotationCatalog } from "./annotation-catalog.js"

const temporaryDirectories: string[] = []

function createCatalog(
	onChanged?: () => void,
	sourceHash = "test-source",
): { catalog: McpAnnotationCatalog; cachePath: string } {
	const directory = mkdtempSync(join(tmpdir(), "kimchi-mcp-annotations-"))
	temporaryDirectories.push(directory)
	const cachePath = join(directory, "annotations.json")
	return { catalog: new McpAnnotationCatalog({ cachePath, onChanged, sourceHash }), cachePath }
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("McpAnnotationCatalog", () => {
	it("uses explicit read-only annotations and rejects explicit false", () => {
		const { catalog } = createCatalog()
		catalog.record([
			{ name: "mutate", description: "safe", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
			{
				name: "get_reset",
				description: "unsafe",
				inputSchema: { type: "object" },
				annotations: { readOnlyHint: false },
			},
		])

		expect(catalog.isReadOnly("mutate", "safe")).toBe(true)
		expect(catalog.isReadOnly("get_reset", "unsafe")).toBe(false)
	})

	it("uses the name fallback only after observing that annotations are absent", () => {
		const { catalog } = createCatalog()

		expect(catalog.isReadOnly("get_issue", "Read issue")).toBe(false)
		catalog.record([
			{ name: "get_issue", description: "Read issue", inputSchema: { type: "object" } },
			{
				name: "list_issues",
				description: "List issues",
				inputSchema: { type: "object" },
				annotations: { destructiveHint: false },
			},
		])
		expect(catalog.isReadOnly("get_issue", "Read issue")).toBe(true)
		expect(catalog.isReadOnly("list_issues", "List issues")).toBe(true)
	})

	it("fails closed when indistinguishable tool observations conflict", () => {
		const { catalog } = createCatalog()
		catalog.record([
			{ name: "lookup", description: "Lookup", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
		])
		catalog.record([
			{ name: "lookup", description: "Lookup", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
		])

		expect(catalog.isReadOnly("lookup", "Lookup")).toBe(false)
	})

	it("fails closed for gateway calls when same-named tools disagree across servers", () => {
		const { catalog } = createCatalog()
		catalog.record([
			{
				name: "lookup",
				description: "Safe lookup",
				inputSchema: { type: "object" },
				annotations: { readOnlyHint: true },
			},
			{
				name: "lookup",
				description: "Mutating lookup",
				inputSchema: { type: "object" },
				annotations: { readOnlyHint: false },
			},
		])

		expect(catalog.isReadOnlyByName("lookup")).toBe(false)
		expect(catalog.isReadOnlyByName("unknown")).toBe(false)
	})

	it("persists observations with private file permissions", () => {
		const changed = vi.fn()
		const { catalog, cachePath } = createCatalog(changed)
		catalog.record([{ name: "list_items", description: "List", inputSchema: { type: "object" } }])

		expect(changed).toHaveBeenCalledOnce()
		expect(JSON.parse(readFileSync(cachePath, "utf8"))).toMatchObject({ version: 2, sourceHash: "test-source" })
		const restored = new McpAnnotationCatalog({ cachePath, sourceHash: "test-source" })
		expect(restored.isReadOnly("list_items", "List")).toBe(true)
	})

	it("does not trust annotations cached for a different server configuration", () => {
		const { catalog, cachePath } = createCatalog(undefined, "old-config")
		catalog.record([
			{
				name: "get_reset",
				description: "Reset data",
				inputSchema: { type: "object" },
				annotations: { readOnlyHint: true },
			},
		])

		const changedConfig = new McpAnnotationCatalog({ cachePath, sourceHash: "new-config" })
		expect(changedConfig.isReadOnly("get_reset", "Reset data")).toBe(false)
	})
})
