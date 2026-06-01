import { execFileSync } from "node:child_process"
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

const CLIPBOARD_POLL_INTERVAL_MS = 2000
let clipboardPollId: ReturnType<typeof setInterval> | null = null
let clipboardHasImage = false

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

function isFinderImageFileCopy(): boolean {
	if (process.platform !== "darwin") return false
	try {
		const raw = execFileSync("/usr/bin/osascript", ["-e", "POSIX path of (the clipboard as «class furl»)"], {
			encoding: "utf8",
			timeout: 1000,
			stdio: ["ignore", "pipe", "ignore"],
		})
		const path = raw.trim()
		return path !== "" && IMAGE_EXT_TO_MIME[extname(path).toLowerCase()] !== undefined
	} catch {
		return false
	}
}

function checkClipboard(): void {
	if (!currentCtx) return

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

		let hasImage = false
		let formats: string[] | null = null
		if (native.availableFormats) {
			try {
				formats = native.availableFormats()
			} catch {
				formats = null
			}
		}

		if (formats?.includes("public.file-url")) {
			// Finder file copy: macOS puts public.file-url + a thumbnail on the pasteboard.
			// hasImage() returns true for any file's thumbnail, so we can't use it here.
			// Resolve the actual file path and check its extension — same logic as the paste handler.
			hasImage = isFinderImageFileCopy()
		} else {
			try {
				hasImage = native.hasImage()
			} catch {
				hasImage = false
			}
			// Fallback: clipboard-rs hasImage() only checks PNG/TIFF.
			// Probe availableFormats for other image types (JPEG, HEIC, WebP, BMP, GIF).
			if (!hasImage && formats) {
				hasImage = formats.some(isImageFormat)
			}
		}

		if (hasImage !== clipboardHasImage) {
			clipboardHasImage = hasImage
			updateIndicator()
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
		clipboardHasImage = false
		currentCtx = ctx
		pendingImages = []
		imageCounter = 0
		const sessionDir = ctx.sessionManager?.getSessionDir?.() ?? null
		const dir = sessionDir ? join(sessionDir, "image-cache") : null
		setImageCacheDir(dir)
		clearAllImages()
		checkClipboard()
		clipboardPollId = setInterval(checkClipboard, CLIPBOARD_POLL_INTERVAL_MS)
	})

	pi.on("session_shutdown", () => {
		if (clipboardPollId !== null) {
			clearInterval(clipboardPollId)
			clipboardPollId = null
		}
		clipboardHasImage = false
		setPendingImageIndicator(null)
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
