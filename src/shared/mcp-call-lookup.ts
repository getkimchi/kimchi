import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getToolSessionScope } from "./planning/tool-session-scope.js"
import type { McpCallFacts } from "../extensions/mcp/call-facts.js"

export type McpCallLookup = (toolName: string, input: unknown) => McpCallFacts

const lookupsByScope = new WeakMap<object, McpCallLookup>()

export function registerMcpCallLookup(pi: ExtensionAPI, lookup: McpCallLookup): () => void {
	const scope = getToolSessionScope(pi)
	lookupsByScope.set(scope, lookup)
	return () => {
		if (lookupsByScope.get(scope) === lookup) lookupsByScope.delete(scope)
	}
}

export function lookupMcpCall(pi: ExtensionAPI, toolName: string, input: unknown): McpCallFacts {
	const lookup = lookupsByScope.get(getToolSessionScope(pi))
	return lookup ? lookup(toolName, input) : { kind: "not_mcp" }
}
