// Upstream deep imports are not exported from the main package, but they
// are on disk in node_modules after install. We use them via deep-module
// paths to avoid duplicating upstream logic.

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
