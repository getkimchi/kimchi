import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const TOOL_SESSION_SCOPE_EVENT = "kimchi:planning-tool-session-scope:v1"

interface ScopeRequest {
	scope?: object
}

/**
 * Resolve one identity shared by every ExtensionAPI wrapper in a session.
 * pi-mono creates a distinct wrapper per extension, but all wrappers publish
 * synchronously through the same session event bus.
 */
export function getToolSessionScope(pi: ExtensionAPI): object {
	const request: ScopeRequest = {}
	pi.events.emit(TOOL_SESSION_SCOPE_EVENT, request)
	if (request.scope) return request.scope

	const scope = {}
	pi.events.on(TOOL_SESSION_SCOPE_EVENT, (candidate: unknown) => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return
		const scopeRequest = candidate as ScopeRequest
		scopeRequest.scope ??= scope
	})
	return scope
}
