/**
 * Typed registration helper for the `before_provider_headers` extension hook.
 *
 * The patched pi-coding-agent runtime adds `emitBeforeProviderHeaders` to
 * ExtensionRunner and calls it in `streamFn` (sdk.js) after static header
 * assembly, allowing extensions to inject per-request dynamic headers
 * (e.g. X-Session-Id, X-Turn-Index) before every LLM HTTP call.
 *
 * The upstream TypeScript types do not yet include this event. TypeScript
 * module augmentation cannot safely add overloads to an existing interface
 * (augmented overloads shadow originals rather than composing with them), so
 * we provide this helper instead of patching ExtensionAPI directly.
 *
 * Tracking: open an upstream PR against pi-mono to add BeforeProviderHeadersEvent
 * and the ExtensionAPI.on() overload to core/extensions/types.ts.
 * Remove this file (and the cast inside `onBeforeProviderHeaders`) once the
 * fixed version is pinned in package.json.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/** Fired in streamFn after static header assembly, before every LLM HTTP call. */
export interface BeforeProviderHeadersEvent {
	type: "before_provider_headers"
	/** The assembled headers so far (attribution + auth + session options). */
	headers: Record<string, string>
}

/** Handler signature for the before_provider_headers hook. */
export type BeforeProviderHeadersHandler = (
	event: BeforeProviderHeadersEvent,
) => Record<string, string> | Promise<Record<string, string>>

/**
 * Register a `before_provider_headers` handler on the given ExtensionAPI.
 *
 * Use this instead of `pi.on("before_provider_headers", ...)` directly — the
 * upstream `ExtensionAPI` type has no overload for this event yet, so calling
 * `.on()` directly requires an `as unknown` cast. This wrapper isolates the
 * cast and provides full type safety for the handler.
 */
export function onBeforeProviderHeaders(pi: ExtensionAPI, handler: BeforeProviderHeadersHandler): void {
	;(
		pi as unknown as {
			on(event: "before_provider_headers", handler: BeforeProviderHeadersHandler): void
		}
	).on("before_provider_headers", handler)
}
