// Upstream deep imports are not exported from the main package, but they
// are on disk in node_modules after install. We use them via deep-module
// paths to avoid duplicating upstream logic.

// ---------------------------------------------------------------------------
// Typed helper: before_provider_headers hook
//
// The patched pi-coding-agent runtime (patches/@earendil-works__pi-coding-agent.patch)
// adds a `before_provider_headers` event to ExtensionRunner and wires it into
// sdk.js, but the published TypeScript types do not include this event.
//
// TypeScript module augmentation cannot safely add overloads to an existing
// interface (augmented overloads shadow originals instead of composing with
// them). The typed registration helper lives in
// src/types/before-provider-headers.ts; import from there instead of using
// an `as unknown` cast.
//
// Tracking: open an upstream PR against pi-mono to add BeforeProviderHeadersEvent
// and the ExtensionAPI.on() overload to core/extensions/types.ts.
// Remove the helper file once the fixed version is pinned.
// ---------------------------------------------------------------------------

declare module "@earendil-works/pi-coding-agent/dist/utils/clipboard-image.js" {
	export type ClipboardImage = {
		bytes: Uint8Array
		mimeType: string
	}
	export function isWaylandSession(env?: NodeJS.ProcessEnv): boolean
	export function extensionForImageMimeType(mimeType: string): string | null
	export function readClipboardImage(options?: {
		env?: NodeJS.ProcessEnv
		platform?: NodeJS.Platform
	}): Promise<ClipboardImage | null>
}
