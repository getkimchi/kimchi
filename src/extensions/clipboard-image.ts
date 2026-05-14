import { join } from "node:path"
import type { ImageContent } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getAvailableModels } from "../startup-context.js"
import { getNativeClipboard } from "../utils/clipboard-native-harness.js"
import { readClipboardImage } from "../utils/clipboard-read.js"
import { addImage, clearAllImages, setImageCacheDir } from "../utils/image-registry.js"
import { setPasteImageHandler, setPendingImageIndicator } from "./ui.js"

let pendingImages: ImageContent[] = []
let currentCtx: ExtensionContext | null = null
// Per-session running counter of images attached to user turns. Resets on
// session_start so that a new conversation always begins at #1.
let imageCounter = 0

function modelSupportsImages(modelId: string | undefined): boolean {
	if (!modelId) return false
	const models = getAvailableModels()
	const meta = models.find((m) => m.slug === modelId)
	return meta?.input_modalities.includes("image") ?? false
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
	if (pendingImages.length === 0) {
		setPendingImageIndicator(null)
		return
	}
	const totalRawBytes = pendingImages.reduce((sum, img) => sum + Math.floor((img.data.length * 3) / 4), 0)
	const kb = Math.max(1, Math.round(totalRawBytes / 1024))
	const label = pendingImages.length === 1 ? "image" : "images"
	setPendingImageIndicator(`📎 ${pendingImages.length} ${label} (${kb} KB)`)
}

export default function clipboardImageExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx
		pendingImages = []
		imageCounter = 0
		const sessionDir = ctx.sessionManager?.getSessionDir?.() ?? null
		const dir = sessionDir ? join(sessionDir, "image-cache") : null
		setImageCacheDir(dir)
		clearAllImages()
		updateIndicator()
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
