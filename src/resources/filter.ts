// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { isResourceEnabled } from "./store.js"

export interface ManagedExtensionFactory {
	id: string
	factory: ExtensionFactory
}

export function enabledExtensionFactories(factories: readonly ManagedExtensionFactory[]): ExtensionFactory[] {
	return factories.filter(({ id }) => isResourceEnabled(id)).map(({ factory }) => factory)
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
