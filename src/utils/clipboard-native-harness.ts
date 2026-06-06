// Native clipboard NAPI-RS addon loader.
//
// Upstream pi-coding-agent has `utils/clipboard-native.js` which does:
//   require("@mariozechner/clipboard")
// That package is an index.js loader which does a *runtime* require of the
// platform-specific package (`@mariozechner/clipboard-darwin-arm64`, etc.).
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
//
// WSL / headless Linux note:
// The clipboard-rs Rust library calls XOpenDisplay() during ClipboardContext
// initialisation. On Linux without a real X11/Wayland server this call
// panics (Rust unwrap on Err) rather than returning a JS exception, killing
// the entire process. We therefore probe the binding immediately after
// loading it by calling availableFormats() inside the same try/catch block.
// A Rust panic propagates as a process abort that cannot be caught in JS, so
// the only safe strategy is to never load the binding when there is no
// display server. We also detect WSL explicitly (via WSL_DISTRO_NAME /
// WSL_INTEROP) because WSLg may set $DISPLAY to ":0" even when no graphical
// session is running, giving a false positive to the simple display check.

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
			return require("@mariozechner/clipboard-darwin-arm64/clipboard.darwin-arm64.node") as NativeClipboard
		if (process.arch === "x64")
			return require("@mariozechner/clipboard-darwin-x64/clipboard.darwin-x64.node") as NativeClipboard
		throw new Error(`Unsupported macOS architecture: ${process.arch}`)
	}
	if (process.platform === "linux") {
		if (process.arch === "arm64") {
			try {
				return require("@mariozechner/clipboard-linux-arm64-gnu/clipboard.linux-arm64-gnu.node") as NativeClipboard
			} catch {
				return require("@mariozechner/clipboard-linux-arm64-musl/clipboard.linux-arm64-musl.node") as NativeClipboard
			}
		}
		if (process.arch === "x64") {
			try {
				return require("@mariozechner/clipboard-linux-x64-gnu/clipboard.linux-x64-gnu.node") as NativeClipboard
			} catch {
				return require("@mariozechner/clipboard-linux-x64-musl/clipboard.linux-x64-musl.node") as NativeClipboard
			}
		}
		throw new Error(`Unsupported Linux architecture: ${process.arch}`)
	}
	if (process.platform === "win32") {
		if (process.arch === "arm64")
			return require("@mariozechner/clipboard-win32-arm64-msvc/clipboard.win32-arm64-msvc.node") as NativeClipboard
		if (process.arch === "x64")
			return require("@mariozechner/clipboard-win32-x64-msvc/clipboard.win32-x64-msvc.node") as NativeClipboard
		throw new Error(`Unsupported Windows architecture: ${process.arch}`)
	}
	throw new Error(`Unsupported platform: ${process.platform}`)
}

/**
 * Return true when the environment has (or may have) a working display server.
 *
 * On WSL the kernel sets WSL_DISTRO_NAME / WSL_INTEROP unconditionally, and
 * WSLg sets $DISPLAY even when no graphical session is active. We therefore
 * treat WSL as "no display" unless the user has explicitly opted in by
 * setting KIMCHI_CLIPBOARD_FORCE=1. Requires DISPLAY to be set because the
 * underlying clipboard-rs library only supports X11. WAYLAND_DISPLAY alone
 * is not sufficient.
 */
export function hasDisplayServer(): boolean {
	if (process.platform !== "linux") return true
	if (process.env.KIMCHI_CLIPBOARD_FORCE === "1") return true
	const isWsl = Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
	if (isWsl) return false
	return Boolean(process.env.DISPLAY)
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

	if (process.env.TERMUX_VERSION || !hasDisplayServer()) {
		loadError = process.env.TERMUX_VERSION
			? "Clipboard image support is not available: Termux is not supported"
			: "Clipboard image support is not available: no display server detected (WSL/headless Linux — set KIMCHI_CLIPBOARD_FORCE=1 to override)"
		cached = null
		return { clipboard: null, error: loadError }
	}

	try {
		const binding = loadPlatformBinding()
		// Eagerly probe the binding so that a Rust panic from a broken display
		// server (e.g. $DISPLAY set but X server not running) surfaces here
		// inside this try/catch rather than later in a polling callback where
		// it would abort the process. availableFormats() calls
		// ClipboardContext::new() internally which is the call that panics.
		// NOTE: a genuine Rust panic is a process abort and cannot be caught
		// in JS. The probe only helps for recoverable JS-level errors. The
		// real protection is hasDisplayServer() above refusing to load at all
		// in environments known to lack a working display server.
		binding.availableFormats()
		cached = binding
	} catch (err) {
		cached = null
		loadError = err instanceof Error ? err.message : String(err)
	}

	return { clipboard: cached, error: loadError }
}
