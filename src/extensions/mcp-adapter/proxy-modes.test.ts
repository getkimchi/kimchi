/**
 * Unit tests for the read-only marker surfaced in `executeSearch` and
 * `executeDescribe` proxy output (proxy-modes.ts).
 *
 * Asserts that a tool whose `annotations.readOnlyHint` is `true` (or that
 * qualifies via the name heuristic) shows a `[read-only]` tag in search
 * results and a `Read-only:` line in describe output, while a write tool
 * (explicit `readOnlyHint:false` with a non-matching name) shows neither.
 */
import { describe, expect, it } from "vitest"
import { executeDescribe, executeSearch } from "./proxy-modes.js"
import type { McpExtensionState } from "./state.js"
import type { ToolMetadata } from "./types.js"

const SERVER = "testserver"

function makeMetadata(
	originalName: string,
	annotations?: ToolMetadata["annotations"],
): ToolMetadata {
	return {
		name: `${SERVER}_${originalName}`,
		originalName,
		description: `tool ${originalName}`,
		inputSchema: { type: "object", properties: {} },
		annotations,
	}
}

function makeState(metadata: ToolMetadata[]): McpExtensionState {
	return {
		manager: {} as McpExtensionState["manager"],
		lifecycle: {} as McpExtensionState["lifecycle"],
		toolMetadata: new Map([[SERVER, metadata]]),
		config: { mcpServers: { [SERVER]: {} as McpExtensionState["config"]["mcpServers"][string] } },
		failureTracker: new Map(),
		uiResourceHandler: {} as McpExtensionState["uiResourceHandler"],
		consentManager: {} as McpExtensionState["consentManager"],
		uiServer: null,
		completedUiSessions: [],
		openBrowser: async () => {},
		dynamicToolNames: new Set(),
	} as unknown as McpExtensionState
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	const block = result.content[0]
	return block?.type === "text" ? (block.text ?? "") : ""
}

describe("executeSearch — read-only marker", () => {
	it("appends [read-only] for an annotated read-only tool (readOnlyHint:true)", () => {
		const meta = makeMetadata("get_record", { readOnlyHint: true })
		const state = makeState([meta])

		const result = executeSearch(state, "record", undefined, undefined, undefined, undefined, 5)
		const text = resultText(result)

		expect(text).toContain("[read-only]")
		expect(text).toContain(meta.name)
	})

	it("appends [read-only] for an un-annotated heuristic-matching tool (get_ prefix)", () => {
		const meta = makeMetadata("get_record") // no annotations -> heuristic
		const state = makeState([meta])

		const result = executeSearch(state, "record", undefined, undefined, undefined, undefined, 5)
		const text = resultText(result)

		expect(text).toContain("[read-only]")
	})

	it("does not append [read-only] for an explicit write tool (readOnlyHint:false, non-matching name)", () => {
		const meta = makeMetadata("create_record", { readOnlyHint: false })
		const state = makeState([meta])

		const result = executeSearch(state, "record", undefined, undefined, undefined, undefined, 5)
		const text = resultText(result)

		expect(text).not.toContain("[read-only]")
		expect(text).toContain(meta.name)
	})

	it("does not append [read-only] for an un-annotated non-matching tool name", () => {
		const meta = makeMetadata("create_record") // no annotations, non-matching prefix
		const state = makeState([meta])

		const result = executeSearch(state, "record", undefined, undefined, undefined, undefined, 5)
		const text = resultText(result)

		expect(text).not.toContain("[read-only]")
	})

	it("surfaces the marker in compact (includeSchemas=false) output too", () => {
		const meta = makeMetadata("get_record", { readOnlyHint: true })
		const state = makeState([meta])

		const result = executeSearch(state, "record", undefined, undefined, false, undefined, 5)
		const text = resultText(result)

		expect(text).toContain("[read-only]")
	})
})

describe("executeDescribe — read-only marker", () => {
	it("includes a Read-only line for an annotated read-only tool (readOnlyHint:true)", () => {
		const meta = makeMetadata("get_record", { readOnlyHint: true })
		const state = makeState([meta])

		const result = executeDescribe(state, meta.name)
		const text = resultText(result)

		expect(text).toContain("Read-only:")
		expect(text).toContain("safe to call during planning/scoping")
	})

	it("includes a Read-only line for an un-annotated heuristic-matching tool", () => {
		const meta = makeMetadata("get_record")
		const state = makeState([meta])

		const result = executeDescribe(state, meta.name)
		const text = resultText(result)

		expect(text).toContain("Read-only:")
	})

	it("does not include a Read-only line for an explicit write tool", () => {
		const meta = makeMetadata("create_record", { readOnlyHint: false })
		const state = makeState([meta])

		const result = executeDescribe(state, meta.name)
		const text = resultText(result)

		expect(text).not.toContain("Read-only:")
		expect(text).toContain(meta.name)
	})

	it("does not include a Read-only line for an un-annotated non-matching tool name", () => {
		const meta = makeMetadata("create_record")
		const state = makeState([meta])

		const result = executeDescribe(state, meta.name)
		const text = resultText(result)

		expect(text).not.toContain("Read-only:")
	})
})
