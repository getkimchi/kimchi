import { join } from "node:path"
import type { ImageContent } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getAvailableModels } from "../startup-context.js"
import { getNativeClipboard } from "../utils/clipboard-native-harness.js"
import { readClipboardImage } from "../utils/clipboard-read.js"
import { addImage, clearAllImages, setImageCacheDir } from "../utils/image-registry.js"
import { insertAtCursor, setPasteImageHandler, setPendingImageIndicator } from "./ui.js"

// Slots filled async after paste; null means image read is still in-flight or failed.
let pendingImages: (ImageContent | null)[] = []
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

setPasteImageHandler(() => {
	// Synchronous checks first — bail early without reserving a slot.
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

	// Reserve the slot and insert the marker synchronously so it lands at the
	// cursor position before any async work can shift state.
	// Capture the array reference so in-flight callbacks stay bound to this
	// session's bucket even if session_start replaces pendingImages later.
	const bucket = pendingImages
	const slot = bucket.length
	bucket.push(null)
	insertAtCursor("📎")

	// Fill in the actual image data asynchronously.
	readClipboardImage()
		.then((image) => {
			if (!image) {
				// Leave bucket[slot] as null — the 📎 marker will be stripped on submit.
				currentCtx?.ui?.notify("No image found on clipboard", "info")
				return
			}
			const base64 = Buffer.from(image.bytes).toString("base64")
			bucket[slot] = { type: "image", data: base64, mimeType: image.mimeType }
		})
		.catch(() => {
			// Leave bucket[slot] as null — the 📎 marker will be stripped on submit.
			currentCtx?.ui?.notify("Clipboard image support is not available", "warning")
		})
})

export default function clipboardImageExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx
		pendingImages = []
		imageCounter = 0
		const sessionDir = ctx.sessionManager?.getSessionDir?.() ?? null
		const dir = sessionDir ? join(sessionDir, "image-cache") : null
		setImageCacheDir(dir)
		clearAllImages()
		setPendingImageIndicator(null)
	})

	pi.on("input", (event) => {
		const incoming = event.images ?? []
		// Count 📎 markers in text — each maps to a pending slot in push order.
		const markerCount = (event.text.match(/📎/gu) ?? []).length

		if (incoming.length === 0 && markerCount === 0) return

		// Only consume pending slots when there are markers to resolve.
		// Skipping this when markerCount === 0 prevents programmatic follow-up
		// messages (e.g. from ferment) from clearing slots before the user submits.
		let pendingSlots: (ImageContent | null)[] = []
		if (markerCount > 0) {
			const captured = pendingImages
			pendingImages = []
			pendingSlots = captured.slice(0, markerCount)
		}

		const validPending = pendingSlots.filter((img): img is ImageContent => img !== null)
		const images = [...incoming, ...validPending]

		const startIndex = imageCounter + 1
		imageCounter += images.length
		images.forEach((image, i) => addImage(startIndex + i, image))

		// Replace 📎 markers left-to-right with [Image #N].
		// Orphaned markers (failed load or no backing slot) are stripped from the text.
		let slotIdx = 0
		let sessionIdx = startIndex + incoming.length
		const text = event.text.replace(/📎/gu, () => {
			const slot = pendingSlots[slotIdx++]
			return slot != null ? `[Image #${sessionIdx++}]` : ""
		})

		return { action: "transform" as const, text, images }
	})
}
