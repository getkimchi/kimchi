import { describe, expect, it } from "vitest"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { lookupMcpCall, registerMcpCallLookup } from "./call-lookup.js"

const firstFacts = { kind: "metadata", op: "status" } as const
const secondFacts = { kind: "unresolved", via: "direct", why: "unknown" } as const

describe("MCP call lookup registry", () => {
	it("returns not_mcp when no lookup is registered", () => {
		const harness = createExtensionApi()

		expect(lookupMcpCall(harness.api, "docs_get_issue", { id: "LLM-4358" })).toEqual({ kind: "not_mcp" })
	})

	it("keeps lookups isolated by tool session scope", () => {
		const first = createExtensionApi()
		const second = createExtensionApi()
		registerMcpCallLookup(first.api, () => firstFacts)
		registerMcpCallLookup(second.api, () => secondFacts)

		expect(lookupMcpCall(first.api, "mcp", {})).toEqual(firstFacts)
		expect(lookupMcpCall(second.api, "mcp", {})).toEqual(secondFacts)
	})

	it("replaces a session lookup without letting old cleanup remove the new lookup", () => {
		const first = createExtensionApi()
		const second = createExtensionApi()
		const removeFirst = registerMcpCallLookup(first.api, () => firstFacts)
		registerMcpCallLookup(second.api, () => secondFacts)
		const removeReplacement = registerMcpCallLookup(first.api, () => secondFacts)

		removeFirst()

		expect(lookupMcpCall(first.api, "mcp", {})).toEqual(secondFacts)
		expect(lookupMcpCall(second.api, "mcp", {})).toEqual(secondFacts)
		removeReplacement()
		expect(lookupMcpCall(first.api, "mcp", {})).toEqual({ kind: "not_mcp" })
	})

	it("clears a session lookup on its registered cleanup", () => {
		const first = createExtensionApi()
		const second = createExtensionApi()
		const remove = registerMcpCallLookup(first.api, () => firstFacts)
		registerMcpCallLookup(second.api, () => secondFacts)

		remove()

		expect(lookupMcpCall(first.api, "mcp", {})).toEqual({ kind: "not_mcp" })
		expect(lookupMcpCall(second.api, "mcp", {})).toEqual(secondFacts)
	})
})
