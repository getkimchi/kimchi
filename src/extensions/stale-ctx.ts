// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
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
//
// Exported so every consumer (guards AND test fixtures simulating the throw)
// shares one spelling: if upstream rewords the message, this constant is the
// single place to update.
export const STALE_CTX_MESSAGE_PREFIX = "This extension ctx is stale"

export function isStaleCtxError(err: unknown): boolean {
	return err instanceof Error && err.message.startsWith(STALE_CTX_MESSAGE_PREFIX)
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker

export const DUMB_TEST_MARKER_LLM_4329 = "llm-4329-dumb-test-marker"
