import type { McpCallFacts } from "./call-facts.js"

export type AutoMcpDecision =
	| { action: "allow"; sourceDetail: "mcp_gateway_readonly" | "mcp_readonly_annotation" }
	| { action: "classify" }
	| { action: "current" }

/**
 * Auto mode treats `readOnlyHint: true` as an authorization assertion from the
 * configured server. Kimchi cannot verify it. The callers limit this trust:
 * deny and allow rules run first, and cached hints count only when the config
 * hash matches and the TTL is valid. See docs/mcp-adapter-audit.md.
 */
export function decideAutoMcpCall(facts: McpCallFacts): AutoMcpDecision {
	if (facts.kind === "metadata") return { action: "allow", sourceDetail: "mcp_gateway_readonly" }
	if (facts.kind !== "tool") return { action: "current" }
	if (facts.evidence === "annotation_true") return { action: "allow", sourceDetail: "mcp_readonly_annotation" }
	if (facts.evidence === "annotation_false" || facts.evidence === "none") return { action: "classify" }
	return { action: "current" }
}
