import type { McpCallFacts } from "./call-facts.js"

export type AutoMcpDecision =
	| { action: "allow"; sourceDetail: "mcp_gateway_readonly" | "mcp_readonly_annotation" }
	| { action: "classify" }
	| { action: "current" }

export function decideAutoMcpCall(facts: McpCallFacts): AutoMcpDecision {
	if (facts.kind === "metadata") return { action: "allow", sourceDetail: "mcp_gateway_readonly" }
	if (facts.kind !== "tool") return { action: "current" }
	if (facts.evidence === "annotation_true") return { action: "allow", sourceDetail: "mcp_readonly_annotation" }
	if (facts.evidence === "annotation_false" || facts.evidence === "none") return { action: "classify" }
	return { action: "current" }
}
