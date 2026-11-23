import { describe, expect, it } from "vitest"
import { decideAutoMcpCall } from "./auto-policy.js"

describe("decideAutoMcpCall", () => {
	it("allows metadata with mcp_gateway_readonly", () => {
		expect(decideAutoMcpCall({ kind: "metadata", op: "search" })).toEqual({
			action: "allow",
			sourceDetail: "mcp_gateway_readonly",
		})
	})

	it("allows annotation_true with mcp_readonly_annotation", () => {
		expect(
			decideAutoMcpCall({
				kind: "tool",
				via: "direct",
				server: "example",
				tool: "delete_item",
				evidence: "annotation_true",
			}),
		).toEqual({ action: "allow", sourceDetail: "mcp_readonly_annotation" })
	})

	it("classifies annotation_false and none without name taxonomy", () => {
		expect(
			decideAutoMcpCall({
				kind: "tool",
				via: "gateway",
				server: "example",
				tool: "get_item",
				evidence: "annotation_false",
			}),
		).toEqual({ action: "classify" })
		expect(
			decideAutoMcpCall({
				kind: "tool",
				via: "namespace",
				server: "example",
				tool: "get_item",
				evidence: "none",
			}),
		).toEqual({ action: "classify" })
	})

	it("keeps current handling for unannotated name_convention and resource", () => {
		expect(
			decideAutoMcpCall({
				kind: "tool",
				via: "direct",
				server: "example",
				tool: "get_item",
				evidence: "unannotated",
			}),
		).toEqual({ action: "current" })
		expect(
			decideAutoMcpCall({
				kind: "tool",
				via: "direct",
				server: "example",
				tool: "get_item",
				evidence: "name_convention",
			}),
		).toEqual({ action: "current" })
		expect(
			decideAutoMcpCall({
				kind: "tool",
				via: "direct",
				server: "example",
				tool: "get_item",
				evidence: "resource",
			}),
		).toEqual({ action: "current" })
	})

	it("keeps current handling for unresolved calls", () => {
		expect(decideAutoMcpCall({ kind: "unresolved", via: "gateway", why: "unknown" })).toEqual({
			action: "current",
		})
	})

	it("keeps current handling for not_mcp calls", () => {
		expect(decideAutoMcpCall({ kind: "not_mcp" })).toEqual({ action: "current" })
	})
})
