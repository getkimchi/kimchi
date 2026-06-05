import { execFile } from "node:child_process"
import { extname, join } from "node:path"
import type { ImageContent } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getAvailableModels } from "../startup-context.js"
import { getNativeClipboard } from "../utils/clipboard-native-harness.js"
import { readClipboardImage } from "../utils/clipboard-read.js"
import { addImage, clearAllImages, setImageCacheDir } from "../utils/image-registry.js"
import { IMAGE_EXT_TO_MIME } from "../utils/image-utils.js"
import { setPasteImageHandler, setPendingImageIndicator } from "./ui.js"

let pendingImages: ImageContent[] = []
let currentCtx: ExtensionContext | null = null
// Per-session running counter of images attached to user turns. Resets on
// session_start so that a new conversation always begins at #1.
let imageCounter = 0

const CLIPBOARD_POLL_INTERVAL_MS = 1000
let clipboardPollId: ReturnType<typeof setInterval> | null = null
let clipboardHasImage = false
let isCheckingFinder = false
// Monotonic counter incremented on every session_start. Async callbacks
// capture the generation at launch and bail out if it no longer matches,
// preventing stale Finder checks from corrupting a newer session's state.
let sessionGeneration = 0

function modelSupportsImages(modelId: string | undefined): boolean {
	if (!modelId) return false
	const models = getAvailableModels()
	const meta = models.find((m) => m.slug === modelId)
	return meta?.input_modalities.includes("image") ?? false
}

function isImageFormat(format: string): boolean {
	// Match common image MIME types and macOS UTI identifiers
	return /^(public\.(png|tiff|jpeg|jpg|heic|webp|bmp|gif|image)|com\.apple\.png|com\.compuserve\.gif|image\/)/i.test(
		format,
	)
}

type FinderFileResult = "image" | "non-image" | null

function checkFinderImageFileCopy(): Promise<FinderFileResult> {
	return new Promise<FinderFileResult>((resolve) => {
		if (process.platform !== "darwin") {
			resolve(null)
			return
		}
		execFile(
			"/usr/bin/osascript",
			["-e", "POSIX path of (the clipboard as «class furl»)"],
			{ encoding: "utf8", timeout: 1000 },
			(err, stdout) => {
				if (err) {
					resolve(null)
					return
				}
				const path = stdout.trim()
				if (!path) {
					resolve(null)
					return
				}
				const isImage = IMAGE_EXT_TO_MIME[extname(path).toLowerCase()] !== undefined
				resolve(isImage ? "image" : "non-image")
			},
		)
	})
}

function checkClipboard(): void {
	if (!currentCtx) return
	if (isCheckingFinder) return

	try {
		if (!modelSupportsImages(currentCtx.model?.id)) {
			if (clipboardHasImage) {
				clipboardHasImage = false
				updateIndicator()
			}
			return
		}

		const { clipboard: native } = getNativeClipboard()
		if (!native) {
			if (clipboardHasImage) {
				clipboardHasImage = false
				updateIndicator()
			}
			return
		}

		let formats: string[] | null = null
		if (native.availableFormats) {
			try {
				formats = native.availableFormats()
			} catch {
				formats = null
			}
		}

		let baselineHasImage = false
		try {
			baselineHasImage = native.hasImage()
		} catch {
			baselineHasImage = false
		}
		// Fallback: clipboard-rs hasImage() only checks PNG/TIFF.
		// Probe availableFormats for other image types (JPEG, HEIC, WebP, BMP, GIF).
		if (!baselineHasImage && formats) {
			baselineHasImage = formats.some(isImageFormat)
		}

		if (baselineHasImage && formats?.includes("public.file-url")) {
			// Finder file copy: macOS puts public.file-url + a thumbnail on the pasteboard.
			// hasImage() returns true for any file's thumbnail. We must verify the file
			// is actually an image (not PDF etc.) before showing the hint.
			// Resolve the actual file path asynchronously to avoid blocking the event loop.
			isCheckingFinder = true
			const myGeneration = sessionGeneration
			checkFinderImageFileCopy()
				.then((result) => {
					if (myGeneration !== sessionGeneration) return // stale callback
					// Only suppress the indicator when we CONFIRM the file is not an image.
					// If there is no file path (null) we keep the baseline — this handles
					// spurious public.file-url reports from macOS and AppleScript timeouts.
					const final = result === "non-image" ? false : baselineHasImage
					if (final !== clipboardHasImage) {
						clipboardHasImage = final
						updateIndicator()
					}
				})
				.catch(() => {})
				.finally(() => {
					if (myGeneration === sessionGeneration) {
						isCheckingFinder = false
					}
				})
		} else {
			if (baselineHasImage !== clipboardHasImage) {
				clipboardHasImage = baselineHasImage
				updateIndicator()
			}
		}
	} catch (err) {
		console.error("[clipboard-image] Proactive clipboard check failed:", err)
	}
}

function buildImageMarkerPrefix(startIndex: number, count: number): string {
	if (count <= 0) return ""
	const markers = Array.from({ length: count }, (_, i) => `[Image #${startIndex + i}]`)
	return markers.join(" ")
}

setPasteImageHandler(() => {
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

	const { clipboard: native, error } = getNativeClipboard()
	if (!native) {
		const detail = error ? `: ${error}` : ""
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

function updateIndicator(): void {
	const count = pendingImages.length
	if (count > 0) {
		const totalRawBytes = pendingImages.reduce((sum, img) => sum + Math.floor((img.data.length * 3) / 4), 0)
		const kb = Math.max(1, Math.round(totalRawBytes / 1024))
		const label = count === 1 ? "image" : "images"
		setPendingImageIndicator(`📎 ${count} ${label} (${kb} KB)`)
	} else if (clipboardHasImage) {
		setPendingImageIndicator("Image in clipboard · ctrl+v to paste")
	} else {
		setPendingImageIndicator(null)
	}
}

export default function clipboardImageExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (clipboardPollId !== null) {
			clearInterval(clipboardPollId)
			clipboardPollId = null
		}
		sessionGeneration++
		isCheckingFinder = false
		currentCtx = ctx
		pendingImages = []
		imageCounter = 0
		const sessionDir = ctx.sessionManager?.getSessionDir?.() ?? null
		const dir = sessionDir ? join(sessionDir, "image-cache") : null
		setImageCacheDir(dir)
		clearAllImages()
		updateIndicator()
		checkClipboard()
		clipboardPollId = setInterval(checkClipboard, CLIPBOARD_POLL_INTERVAL_MS)
	})

	pi.on("session_shutdown", () => {
		if (clipboardPollId !== null) {
			clearInterval(clipboardPollId)
			clipboardPollId = null
		}
		// Increment the generation so any in-flight Finder file-type probe
		// from the dying session is treated as stale when its callback lands.
		sessionGeneration++
		currentCtx = null
	})

	pi.on("input", (event) => {
		const incoming = event.images ?? []
		const totalImages = incoming.length + pendingImages.length

		if (totalImages === 0) return

		const images = [...incoming, ...pendingImages]
		pendingImages = []
		updateIndicator()

		const startIndex = imageCounter + 1
		imageCounter += totalImages
		// Persist each image to disk and register under its [Image #N] id.
		images.forEach((image, i) => {
			const id = startIndex + i
			addImage(id, image)
		})
		const prefix = buildImageMarkerPrefix(startIndex, totalImages)
		const trimmed = event.text.trimStart()
		const text = trimmed ? `${prefix} ${trimmed}` : prefix

		return { action: "transform" as const, text, images }
	})
}
