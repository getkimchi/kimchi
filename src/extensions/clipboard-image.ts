import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { extname } from "node:path"
import type { ImageContent } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getAvailableModels } from "../startup-context.js"
import { setPasteImageHandler, setPendingImageIndicator } from "./ui.js"

// The native clipboard addon is a NAPI-RS binary distributed as platform-specific
// packages (@mariozechner/clipboard-<platform>-<arch>). Each package ships a
// single .node file. We require the .node file directly via its package-relative
// path so:
//   1. In dev mode (bun run / node), Node's resolver finds the package via
//      our optionalDependencies declaration in package.json (pnpm symlinks the
//      one matching the host platform under node_modules/@earendil-works/).
//   2. In compiled-binary mode (bun build --compile), Bun's bundler statically
//      resolves the .node file at compile time and embeds it inside the
//      executable. At runtime the embedded binary is extracted and loaded —
//      independent of the user's CWD or any on-disk node_modules.
//
// Why not require("@mariozechner/clipboard")? Its index.js loader does a
// runtime `require(`@mariozechner/clipboard-${platform}-${arch}`)`, which Bun's
// compiled binary cannot resolve from the on-disk .pnpm/...index.js context
// (see oven-sh/bun#25635, oven-sh/bun#1843). Static .node imports bypass that.
//
// Why not require("@mariozechner/clipboard-darwin-arm64") (the bare package)?
// Bun's compiled binary fails to resolve packages whose `main` field points at
// a .node file when run from arbitrary cwd. Spelling out the full .node path
// triggers Bun's NAPI embedding code path, which works regardless of cwd.
//
// Why the explicit process.platform/process.arch ladder? Bun's bundler
// substitutes process.platform and process.arch with constants matching the
// build target, then dead-code-eliminates non-matching branches — so only the
// require() for the target platform's .node file is kept and embedded. This
// also means cross-compiling for a non-host platform requires the matching
// @mariozechner/clipboard-<target> package to be available at build time.
interface NativeClipboard {
	hasImage(): boolean
	getImageBinary(): Promise<number[]>
	availableFormats(): string[]
}

// Cap on how big a pasted file we'll inline. 50 MB is well above any practical
// screenshot/photo and below the model providers' typical request-size ceilings
// even after base64 expansion (~67 MB on the wire). A user pasting something
// larger almost certainly didn't mean to dump it into a chat turn.
const MAX_PASTED_FILE_BYTES = 50 * 1024 * 1024

// Mapping from lowercased file extension to the IANA media type we forward to
// the model. Anything not in this set falls through to the addon's PNG
// rendition (or to no-image-found).
const IMAGE_EXT_TO_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
}

// `require` is provided at runtime by Bun's bundler (CommonJS interop) and Node's
// `module` builtins. Declared here as a value rather than imported via
// `createRequire(import.meta.url)` so each call site is a literal specifier the
// bundler can statically resolve and embed.
declare const require: NodeJS.Require

export default function clipboardImageExtension(pi: ExtensionAPI) {
	// Mutable clipboard state — closed over by the helper functions below.
	let _clipboard: NativeClipboard | null | undefined
	let _clipboardLoadError: string | null = null

	function loadPlatformBinding(): NativeClipboard | null {
		if (process.platform === "darwin") {
			if (process.arch === "arm64")
				return require("@mariozechner/clipboard-darwin-arm64/clipboard.darwin-arm64.node") as NativeClipboard
			if (process.arch === "x64")
				return require("@mariozechner/clipboard-darwin-x64/clipboard.darwin-x64.node") as NativeClipboard
			throw new Error(`Unsupported macOS architecture: ${process.arch}`)
		}
		if (process.platform === "linux") {
			// Try glibc first, fall back to musl. Both branches survive bundling because
			// process.platform/arch substitution narrows the platform but not the libc.
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

	function loadClipboard(): NativeClipboard | null {
		if (_clipboard !== undefined) return _clipboard
		const hasDisplay = process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
		if (process.env.TERMUX_VERSION || !hasDisplay) {
			_clipboardLoadError = process.env.TERMUX_VERSION ? "Termux is not supported" : "no display server detected"
			_clipboard = null
			return null
		}
		try {
			_clipboard = loadPlatformBinding()
		} catch (err) {
			// The matching platform package isn't installed. This usually means the
			// user installed on a different OS/arch than they're running on (e.g.
			// installed in a linux-x64 Docker but exec'd via Rosetta). Surface the
			// underlying error so it's actionable.
			_clipboardLoadError = err instanceof Error ? err.message : String(err)
			_clipboard = null
		}
		return _clipboard
	}

	// Read a single file URL off the macOS pasteboard, if one is present and points
	// at a regular file with a recognized image extension. Returns null in every
	// other case (no file URL, multiple files, non-image extension, file unreadable,
	// file too large). Errors here are intentionally swallowed: this is a *fallback*
	// path that runs alongside the native addon, and any failure should fall
	// through to the addon rather than break the paste.
	//
	// Why not consult the addon? Its `availableFormats()` confirms a `public.file-url`
	// is present, but the addon exposes no API to retrieve the URL's *value* — text
	// accessors panic on file-URL-only pasteboards. AppleScript is the cheapest
	// reliable way to read the URL string itself. The `availableFormats()` gate
	// prevents AppleScript from coercing arbitrary text into a fake `/hello`-style
	// path on a text-only pasteboard.
	function readPastedFilePathDarwin(formats: string[]): string | null {
		if (process.platform !== "darwin") return null
		if (!formats.includes("public.file-url")) return null
		try {
			const raw = execFileSync("/usr/bin/osascript", ["-e", "POSIX path of (the clipboard as «class furl»)"], {
				encoding: "utf8",
				timeout: 1000,
				stdio: ["ignore", "pipe", "ignore"],
			})
			const path = raw.trim()
			if (!path) return null
			return path
		} catch {
			return null
		}
	}

	function readImageFileFromDisk(path: string): { bytes: Uint8Array; mimeType: string } | null {
		const mimeType = IMAGE_EXT_TO_MIME[extname(path).toLowerCase()]
		if (!mimeType) return null

		let buf: Buffer
		try {
			buf = readFileSync(path)
		} catch {
			return null
		}
		if (buf.length === 0 || buf.length > MAX_PASTED_FILE_BYTES) return null
		return { bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), mimeType }
	}

	async function readClipboardImage(): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
		const clipboard = loadClipboard()
		if (!clipboard) return null

		// Step 1: prefer reading the pasted file from disk when available.
		//
		// Background: if the user copied an image *file* in Finder (Cmd+C on the
		// file itself), the macOS pasteboard contains only `public.file-url` and
		// the addon's hasImage() returns false — historically we'd say "No image
		// found" even though the user clearly pasted an image. Worse, if the user
		// copied the file's *icon* (Get Info → click icon → Cmd+C, or via a clipboard
		// manager that re-rendered the URL), the pasteboard ends up with both a
		// file URL *and* a 1024×1024 generic NSImage rendition of the system file
		// icon. hasImage() returns true, getImageBinary() yields the icon, and the
		// model receives a featureless document glyph instead of the user's actual
		// photo.
		//
		// Both failure modes share a cure: if the pasteboard advertises a file URL
		// pointing at an image-typed file we can read, that file's bytes are what
		// the user meant to paste. Read them directly and skip the addon's image
		// rep entirely.
		let formats: string[] = []
		try {
			formats = clipboard.availableFormats()
		} catch {
			// Older addon versions may lack availableFormats(). Treat as empty.
		}
		const path = readPastedFilePathDarwin(formats)
		if (path) {
			const fromDisk = readImageFileFromDisk(path)
			if (fromDisk) return fromDisk
			// File URL exists but isn't a usable image (wrong extension, too big,
			// unreadable). Fall through to the addon — it may still have a screenshot
			// rep alongside the URL.
		}

		// Step 2: fall back to whatever image rep the addon found on the pasteboard.
		if (!clipboard.hasImage()) return null
		const imageData = await clipboard.getImageBinary()
		if (!imageData || imageData.length === 0) return null
		const bytes = imageData instanceof Uint8Array ? imageData : Uint8Array.from(imageData)
		// The native addon always returns PNG on macOS/Windows; on Linux (X11/Wayland)
		// the wl-paste/xclip fallback in pi-mono negotiates the type, but the native
		// binding itself only yields PNG.
		return { bytes, mimeType: "image/png" }
	}

	function modelSupportsImages(modelId: string | undefined): boolean {
		if (!modelId) return false
		const models = getAvailableModels()
		const meta = models.find((m) => m.slug === modelId)
		return meta?.input_modalities.includes("image") ?? false
	}

	// Build the prefix of `[Image #N]` markers we splice into the user's text on
	// submit. Mirrors Claude's UX: every image attached to a turn gets a stable
	// numeric reference the user can name in their prompt, and the counter runs
	// continuously across all turns in a session.
	function buildImageMarkerPrefix(startIndex: number, count: number): string {
		if (count <= 0) return ""
		const markers: string[] = []
		for (let i = 0; i < count; i++) markers.push(`[Image #${startIndex + i}]`)
		return markers.join(" ")
	}

	let pendingImages: ImageContent[] = []
	let currentCtx: ExtensionContext | null = null
	// Per-session running counter of images attached to user turns. Resets on
	// session_start so that a new conversation always begins at #1 — same
	// behavior as Claude's UI.
	let imageCounter = 0

	setPasteImageHandler(() => {
		// onPasteImage is synchronous (void), but clipboard read is async.
		// Fire-and-forget with .catch() to surface errors as notifications.
		handlePaste().catch((err) => {
			console.error("Clipboard paste handler error:", err)
		})
	})

	async function handlePaste(): Promise<void> {
		const model = currentCtx?.model
		if (!modelSupportsImages(model?.id)) {
			currentCtx?.ui?.notify(`${model?.id ?? "Current model"} does not support images`, "warning")
			return
		}

		// If the native addon never loaded, surface that explicitly instead of
		// the misleading "No image found" message — there's no way to ever find
		// an image without the addon.
		if (!loadClipboard()) {
			const detail = _clipboardLoadError ? `: ${_clipboardLoadError}` : ""
			currentCtx?.ui?.notify(`Clipboard image support is not available${detail}`, "warning")
			return
		}

		let image: { bytes: Uint8Array; mimeType: string } | null
		try {
			image = await readClipboardImage()
		} catch {
			currentCtx?.ui?.notify("Clipboard image support is not available", "warning")
			return
		}

		if (!image) {
			currentCtx?.ui?.notify("No image found on clipboard", "info")
			return
		}

		const base64 = Buffer.from(image.bytes).toString("base64")
		const imageContent: ImageContent = {
			type: "image",
			data: base64,
			mimeType: image.mimeType,
		}
		pendingImages.push(imageContent)
		updateIndicator()
	}

	function updateIndicator() {
		if (pendingImages.length === 0) {
			setPendingImageIndicator(null)
			return
		}
		const totalRawBytes = pendingImages.reduce(
			// Each base64 char carries 6 bits; raw bytes ≈ base64Length * 3/4.
			// Padding overshoots by at most 2; close enough for a status line.
			(sum, img) => sum + Math.floor((img.data.length * 3) / 4),
			0,
		)
		const kb = Math.max(1, Math.round(totalRawBytes / 1024))
		const label = pendingImages.length === 1 ? "image" : "images"
		setPendingImageIndicator(`📎 ${pendingImages.length} ${label} (${kb} KB)`)
	}

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx
		pendingImages = []
		imageCounter = 0
		// Editor is rebuilt on every session_start; re-push the current state
		// so the indicator survives session resets that don't clear pendingImages
		// (currently always empty here, but defensive).
		updateIndicator()
	})

	pi.on("input", (event) => {
		// Combine any images already attached to the input event (e.g. from
		// another extension or a future drag-drop path) with our pending paste
		// queue. Both deserve `[Image #N]` markers so the user can refer to them
		// in their prompt and the model gets a textual cue to align text with
		// pixels.
		const incoming = event.images ?? []
		const totalImages = incoming.length + pendingImages.length
		if (totalImages === 0) return

		const images = [...incoming, ...pendingImages]
		pendingImages = []
		updateIndicator()

		const startIndex = imageCounter + 1
		imageCounter += totalImages
		const prefix = buildImageMarkerPrefix(startIndex, totalImages)
		// Preserve a single space between the marker prefix and any user-typed
		// text. If the user submitted with an empty prompt, the markers become
		// the entire visible message — which is fine, the user explicitly chose
		// to send images alone.
		const trimmed = event.text.trimStart()
		const text = trimmed ? `${prefix} ${trimmed}` : prefix

		return { action: "transform" as const, text, images }
	})
}
