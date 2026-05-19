// Helper for detecting the "stale extension ctx" error thrown by pi-coding-agent's
// `assertActive()` when an event handler runs against a torn-down session
// (e.g. an in-flight provider request still firing `before_provider_request` after `/new`).
//
// The library throws a plain `new Error(staleMessage)` with no custom class or `code`
// property, so message-prefix matching is the only stable signal available. Centralized
// here so a future wording change is a one-line fix.
//
// Reference: node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js
//            (`invalidate(message = "This extension ctx is stale...")`)
const STALE_CTX_MESSAGE_PREFIX = "This extension ctx is stale"

export function isStaleCtxError(err: unknown): boolean {
	return err instanceof Error && err.message.startsWith(STALE_CTX_MESSAGE_PREFIX)
}
