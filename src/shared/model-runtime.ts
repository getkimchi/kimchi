// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent"

/**
 * The `ModelRuntime` behind an extension's `ModelRegistry`. Upstream keeps it
 * private, but child sessions need it to share the parent's auth and models.
 */
export function requireModelRuntime(registry: ModelRegistry): ModelRuntime {
	const runtime = (registry as unknown as { runtime?: ModelRuntime }).runtime
	if (!runtime) throw new Error("Pi model registry runtime is unavailable")
	return runtime
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
