// Native clipboard NAPI-RS addon loader.
//
// Upstream pi-coding-agent has `utils/clipboard-native.js` which does:
//   require("@earendil-works/clipboard")
// That package is an index.js loader which does a *runtime* require of the
// platform-specific package (`@earendil-works/clipboard-darwin-arm64`, etc.).
//
// Bun's bundler (`bun build --compile`) resolves `require()` calls at build
// time by following the literal specifier string. A runtime template-string
// require like upstream's cannot be resolved at build time, so the addon
// never gets embedded. The compiled binary then crashes at runtime when it
// tries to load the clipboard.
//
// This module inlines what upstream's loader does, but spells out each
// direct `.node` path as a literal require() argument. Bun substitutes
// `process.platform`/`process.arch` with build-target constants, dead-code
// eliminates non-matching branches, and embeds only the single `.node` file
// needed for the target platform.
//
// See oven-sh/bun#25635 and oven-sh/bun#1843 for the underlying bundler
// limitation.

export type NativeClipboard = {
	hasImage(): boolean
	getImageBinary(): Promise<number[]>
	availableFormats(): string[]
}

let cached: NativeClipboard | null | undefined
let loadError: string | null = null

// `require` is provided at runtime by Bun's bundler so it can statically
// resolve each literal .node specifier at compile time.
declare const require: NodeJS.Require

function loadPlatformBinding(): NativeClipboard {
	if (process.platform === "darwin") {
		if (process.arch === "arm64")
			return require("@earendil-works/clipboard-darwin-arm64/clipboard.darwin-arm64.node") as NativeClipboard
		if (process.arch === "x64")
			return require("@earendil-works/clipboard-darwin-x64/clipboard.darwin-x64.node") as NativeClipboard
		throw new Error(`Unsupported macOS architecture: ${process.arch}`)
	}
	if (process.platform === "linux") {
		if (process.arch === "arm64") {
			try {
				return require("@earendil-works/clipboard-linux-arm64-gnu/clipboard.linux-arm64-gnu.node") as NativeClipboard
			} catch {
				return require("@earendil-works/clipboard-linux-arm64-musl/clipboard.linux-arm64-musl.node") as NativeClipboard
			}
		}
		if (process.arch === "x64") {
			try {
				return require("@earendil-works/clipboard-linux-x64-gnu/clipboard.linux-x64-gnu.node") as NativeClipboard
			} catch {
				return require("@earendil-works/clipboard-linux-x64-musl/clipboard.linux-x64-musl.node") as NativeClipboard
			}
		}
		throw new Error(`Unsupported Linux architecture: ${process.arch}`)
	}
	if (process.platform === "win32") {
		if (process.arch === "arm64")
			return require("@earendil-works/clipboard-win32-arm64-msvc/clipboard.win32-arm64-msvc.node") as NativeClipboard
		if (process.arch === "x64")
			return require("@earendil-works/clipboard-win32-x64-msvc/clipboard.win32-x64-msvc.node") as NativeClipboard
		throw new Error(`Unsupported Windows architecture: ${process.arch}`)
	}
	throw new Error(`Unsupported platform: ${process.platform}`)
}

/**
 * Load the native clipboard addon, or return `null` if the platform is
 * unsupported, has no display server, or the addon is not available.
 * The result is cached for the lifetime of the process.
 */
export function getNativeClipboard(): { clipboard: NativeClipboard | null; error: string | null } {
	if (cached !== undefined) {
		return { clipboard: cached, error: loadError }
	}

	const hasDisplay = process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
	if (process.env.TERMUX_VERSION || !hasDisplay) {
		loadError = process.env.TERMUX_VERSION
			? "Clipboard image support is not available: Termux is not supported"
			: "Clipboard image support is not available: no display server detected"
		cached = null
		return { clipboard: null, error: loadError }
	}

	try {
		cached = loadPlatformBinding()
	} catch (err) {
		cached = null
		loadError = err instanceof Error ? err.message : String(err)
	}

	return { clipboard: cached, error: loadError }
}
