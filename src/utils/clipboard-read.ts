import { execFileSync } from "node:child_process"
import {
	readClipboardImage as readClipboardImagePlatform,
	readClipboardImageViaNativeClipboard,
} from "./clipboard-image.js"
import { getNativeClipboard } from "./clipboard-native-harness.js"
import { hasImageFileContent, readImageFileFromDisk, sniffImageMimeType } from "./image-utils.js"

/** Reject clipboard payloads whose bytes are not a decodable image, keeping
 *  the failure honest at paste time instead of an opaque provider 400 later —
 *  this is what a Finder-copied PDF (or any non-image file) surfaces as when
 *  the pasteboard fallback hands us its raw bytes.
 *
 *  Throws when bytes exist but carry no decodable signature (handlePaste's
 *  catch renders that as "corrupt or unsupported image data"); returns null
 *  untouched (nothing on the clipboard) and re-types valid payloads by
 *  content, so a mislabeled-but-real image still pastes. */
/** Pasteboard-derived text is logged to the terminal; strip C0/C1 control
 *  characters — including ANSI escape introducers — so a crafted file path
 *  cannot repaint or clear the user's screen. Mirrors the gateway-side
 *  helper in llm-gateway-error.ts (same biome workaround applies). */
function stripControlChars(value: string): string {
	// Built from a string pattern: biome's noControlCharactersInRegex only
	// applies to literals, and the ranges here are the whole point.
	return value.replace(new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]", "g"), "")
}

function validateClipboardImage(image: { bytes: Uint8Array; mimeType: string } | null): {
	bytes: Uint8Array
	mimeType: string
} | null {
	if (!image) return null
	const sniffed = sniffImageMimeType(image.bytes)
	if (!sniffed) {
		throw new Error(
			`clipboard image data is not a decodable image (${image.bytes.length} bytes claimed as ${image.mimeType})`,
		)
	}
	return { bytes: image.bytes, mimeType: sniffed }
}

/**
 * Read the most-recent image from the system clipboard.
 *
 * Uses our local `readClipboardImage()` which handles Wayland, X11,
 * WSL PowerShell fallback, and native NAPI.
 *
 * Falls back to a macOS-specific file-URL resolution: when a file is copied
 * in Finder (Cmd+C on the file item), macOS puts `public.file-url` on the
 * pasteboard with no binary image rep. The native addon returns null
 * in this case because `hasImage()` is false. We detect this via the addon's
 * `availableFormats()`, resolve the URL via AppleScript, and read the actual
 * file from disk.
 *
 * Returns `null` if no image is on the clipboard or it cannot be read.
 * Throws if the clipboard holds bytes that are not a decodable image.
 * Sets `degraded: true` when the bytes come from the pasteboard's own
 * representation rather than the original file.
 */
export async function readClipboardImage(): Promise<{
	bytes: Uint8Array
	mimeType: string
	degraded?: boolean
} | null> {
	// Hermetic TUI tests cannot populate the host OS clipboard used by the
	// compiled child process. The shared fixture may point this explicit E2E-only
	// seam at an image inside its isolated workdir.
	const e2eImagePath = process.env.KIMCHI_TUI_E2E_CLIPBOARD_IMAGE
	if (e2eImagePath) {
		const fromDisk = readImageFileFromDisk(e2eImagePath)
		if (fromDisk) return fromDisk
		throw new Error(`KIMCHI_TUI_E2E_CLIPBOARD_IMAGE fixture could not be read as an image: ${e2eImagePath}`)
	}

	// 1. Local implementation handles all normal cases (screenshots, image bytes, etc.)
	const upstream = await readClipboardImagePlatform()
	if (upstream) return validateClipboardImage(upstream)

	// 2. macOS file-URL fallback — only when upstream returns null on Darwin.
	if (process.platform !== "darwin") return null

	const nativeResult = getNativeClipboard()
	if (!nativeResult) return null

	const clipboard = nativeResult.clipboard
	if (!clipboard) return null

	let formats: string[] = []
	try {
		formats = clipboard.availableFormats()
	} catch {
		// Older addon versions lack availableFormats().
		return null
	}

	const path = readPastedFilePathDarwin(formats)
	if (!path) return null

	const fromDisk = readImageFileFromDisk(path)
	if (fromDisk) return fromDisk

	// The Finder-copied file could not be served from disk. Distinguish why:
	// if the file is readable but its content is not an image (e.g. a PDF
	// renamed to .png), the pasteboard's "rendering" is just Finder's
	// placeholder icon — serving it would paste garbage. Fail honestly
	// instead. Only when the file itself is undecidable (unreadable, deleted —
	// it may still be a real image) fall back to the pasteboard representation.
	if (hasImageFileContent(path) === false) {
		throw new Error(`clipboard image data is not a decodable image: ${stripControlChars(path)}`)
	}

	// The disk read failed (sandbox/TCC permissions on ~/Desktop etc., deleted
	// file). Log the path; the failure is otherwise invisible
	// (readImageFileFromDisk swallows errors).
	// Path comes from the pasteboard; strip control bytes before logging so a
	// hostile file name cannot inject terminal escape sequences.
	const safePath = stripControlChars(path)
	console.error(`[clipboard-image] Finder-copied file could not be read from disk: ${safePath}`)
	const validated = validateClipboardImage(await readClipboardImageViaNativeClipboard({ ignoreFileUrlGuard: true }))
	// The pasteboard's own representation may be a thumbnail or a rendering
	// rather than the original file — flag it so the paste handler can tell
	// the user a degraded image was used.
	return validated ? { ...validated, degraded: true } : null
}

/**
 * Check whether the macOS pasteboard advertises a `public.file-url`. If so,
 * resolve it to an absolute POSIX path via AppleScript.
 *
 * Errors are intentionally swallowed — this is a fallback path.
 */
function readPastedFilePathDarwin(formats: string[]): string | null {
	if (!formats.includes("public.file-url")) return null
	try {
		const raw = execFileSync("/usr/bin/osascript", ["-e", "POSIX path of (the clipboard as «class furl»)"], {
			encoding: "utf8",
			timeout: 1000,
			stdio: ["ignore", "pipe", "ignore"],
		})
		const path = raw.trim()
		return path || null
	} catch {
		return null
	}
}
