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

declare module "@earendil-works/pi-coding-agent/dist/cli/file-processor.js" {
	/** Process @file CLI arguments into text content and image attachments
	 *  (upstream inlines non-image files as lossy UTF-8 text). Types only —
	 *  runtime loads it by file URL (see intake.test.ts), as the deep path is
	 *  outside the package's exports map. */
	export function processFileArguments(
		fileArgs: string[],
		options?: { autoResizeImages?: boolean },
	): Promise<{
		text: string
		images: Array<{ type: "image"; mimeType: string; data: string }>
	}>
}
