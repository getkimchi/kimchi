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
 *
 * Unresolved and unannotated calls go to the classifier. The name taxonomy
 * would judge them by the wrapper or server name (`mcp__readwise`), which says
 * nothing about the tool that actually runs.
 */
export function decideAutoMcpCall(facts: McpCallFacts): AutoMcpDecision {
	if (facts.kind === "not_mcp") return { action: "current" }
	if (facts.kind === "metadata") return { action: "allow", sourceDetail: "mcp_gateway_readonly" }
	if (facts.kind === "unresolved") return { action: "classify" }
	switch (facts.evidence) {
		case "annotation_true":
			return { action: "allow", sourceDetail: "mcp_readonly_annotation" }
		case "name_convention":
		case "resource":
			return { action: "current" }
		default:
			return { action: "classify" }
	}
}
