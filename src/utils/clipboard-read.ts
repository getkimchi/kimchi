import { execFileSync } from "node:child_process"

import { readClipboardImage as readClipboardImagePlatform } from "./clipboard-image.js"
import { getNativeClipboard } from "./clipboard-native-harness.js"
import { readImageFileFromDisk } from "./image-utils.js"

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
 */
export async function readClipboardImage(): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
	// 1. Local implementation handles all normal cases (screenshots, image bytes, etc.)
	const upstream = await readClipboardImagePlatform()
	if (upstream) return upstream

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

	return readImageFileFromDisk(path)
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
