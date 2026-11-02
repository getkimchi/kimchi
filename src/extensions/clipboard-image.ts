import { join } from "node:path"
import type { ImageContent } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getNativeClipboard } from "../utils/clipboard-native-harness.js"
import { readClipboardImage } from "../utils/clipboard-read.js"
import { addImage, clearAllImages, setImageCacheDir } from "../utils/image-registry.js"
import { extractTypedImagePaths } from "../utils/typed-image-paths.js"
import { setPasteImageHandler, setPendingImageIndicator } from "./ui.js"
import {
	clearRetained as clearRetainedSubmission,
	consumePathSuppression,
	getPathSuppression,
	getRetainedSubmission,
	getVisionGateSessionGeneration,
	mergeRetainedSubmission,
	type PathAttachment,
	registerVisionGateSideEffects,
	resetVisionGateState,
	runVisionGate,
	visionGateOnAgentEnd,
} from "./vision-gate.js"
import { modelSupportsImages, needsVisionSwitch } from "./vision-support.js"

let pendingImages: ImageContent[] = []
let currentCtx: ExtensionContext | null = null
// Per-session running counter of images attached to user turns. Resets on
// session_start so that a new conversation always begins at #1.
let imageCounter = 0

const CLIPBOARD_POLL_INTERVAL_MS = 1000
let clipboardPollId: ReturnType<typeof setInterval> | null = null
let clipboardHasImage = false

function isImageFormat(format: string): boolean {
	// Match common image MIME types and macOS UTI identifiers
	return /^(public\.(png|tiff|jpeg|jpg|heic|webp|bmp|gif|image)|com\.apple\.png|com\.compuserve\.gif|image\/)/i.test(
		format,
	)
}

function checkClipboard(): void {
	if (!currentCtx) return

	try {
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

		let hasImage = false
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
	const { clipboard: native, error } = getNativeClipboard()
	if (!native && !process.env.KIMCHI_TUI_E2E_CLIPBOARD_IMAGE) {
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
	// Paste is accepted regardless of the current model's capabilities — the
	// submit-time vision gate is the single choke point. The text-only hint
	// rides the pending-image indicator (not a chat warning, which cannot be
	// retracted once the model switches): it clears itself on model_select.
}

function updateIndicator(): void {
	const count = pendingImages.length
	if (count > 0) {
		const totalRawBytes = pendingImages.reduce((sum, img) => sum + Math.floor((img.data.length * 3) / 4), 0)
		const kb = Math.max(1, Math.round(totalRawBytes / 1024))
		const label = count === 1 ? "image" : "images"
		const visionHint = needsVisionSwitch(currentCtx?.model) ? " · ⚠ text-only" : ""
		setPendingImageIndicator(`📎 ${count} ${label} (${kb} KB)${visionHint}`)
	} else if (clipboardHasImage) {
		setPendingImageIndicator("Image in clipboard · ctrl+v to paste")
	} else {
		setPendingImageIndicator(null)
	}
}

export default function clipboardImageExtension(pi: ExtensionAPI): void {
	registerVisionGateSideEffects({
		clearPendingAttachments: () => {
			pendingImages = []
			updateIndicator()
		},
	})

	pi.on("session_start", (_event, ctx) => {
		if (clipboardPollId !== null) {
			clearInterval(clipboardPollId)
			clipboardPollId = null
		}
		currentCtx = ctx
		pendingImages = []
		imageCounter = 0
		// On-demand sessions never re-probe, so a hint left by a previous
		// proactive session would advertise an image that was not read again.
		clipboardHasImage = false
		// Reset the vision gate's retained state, suppressions, deferred latch,
		// and dialog ownership so a replacement session starts clean.
		resetVisionGateState()
		const sessionDir = ctx.sessionManager?.getSessionDir?.() ?? null
		const dir = sessionDir ? join(sessionDir, "image-cache") : null
		setImageCacheDir(dir)
		clearAllImages()
		updateIndicator()
		// Linux shells out to wl-paste/xclip; polling can open transient
		// surfaces that steal focus on Wayland. macOS matches that on-demand
		// policy (TUI and ACP): an idle one-second poll spawned osascript for
		// every open session when a screenshot also carried public.file-url
		// (#1345). There is no proactive "Image in clipboard" hint on either
		// platform. Ctrl+V still reads the pasteboard and attaches the image.
		// Windows keeps the native format poll below.
		if (process.platform !== "linux" && process.platform !== "darwin") {
			checkClipboard()
			clipboardPollId = setInterval(checkClipboard, CLIPBOARD_POLL_INTERVAL_MS)
		}
	})

	pi.on("session_shutdown", () => {
		if (clipboardPollId !== null) {
			clearInterval(clipboardPollId)
			clipboardPollId = null
		}
		currentCtx = null
		resetVisionGateState()
	})

	pi.on("agent_end", (_event, ctx) => {
		// Deferred vision-gate dialog for streaming-intercepted submissions.
		visionGateOnAgentEnd(pi, ctx)
	})

	pi.on("model_select", () => {
		// The pending-image indicator carries a model-dependent `· ⚠ text-only`
		// segment; refresh it when the model changes (e.g. the vision gate's
		// switch) so the hint clears itself instead of lingering.
		updateIndicator()
	})

	pi.on("input", async (event, ctx) => {
		const isInteractiveTui = ctx.mode === "tui" && event.source === "interactive"
		const incoming = event.images ?? []

		// Deferred-Remove suppression: hide the removed paths while the exact
		// restored draft is retried. Consume it only once that input is accepted;
		// a cancelled gate attempt must leave it armed.
		const gateGeneration = getVisionGateSessionGeneration()
		const suppressedPaths = isInteractiveTui ? getPathSuppression(event.text, gateGeneration) : null

		// Local image file paths in the submitted text (typed, pasted, or dropped)
		// are attached like pasted images. Within the interactive TUI boundary
		// extraction is intentionally unconditional — the submit-time vision gate
		// below is the only vision check for those submissions, so typed paths
		// reach the gate instead of being silently dropped. Outside the boundary
		// extraction stays vision-gated (existing behavior: vision-less models
		// keep the text untouched so the read tool remains the fallback).
		// Path images are appended after pasted/attached ones so existing
		// marker numbering is unchanged.
		const extractPaths = isInteractiveTui || modelSupportsImages(ctx.model)
		const freshMatches = extractPaths ? extractTypedImagePaths(event.text, ctx.cwd) : []
		const pathMatches: PathAttachment[] = (
			suppressedPaths ? freshMatches.filter((m) => !suppressedPaths.has(m.resolvedPath)) : freshMatches
		).map((match) => ({
			resolvedPath: match.resolvedPath,
			image: {
				type: "image" as const,
				data: Buffer.from(match.image.bytes).toString("base64"),
				mimeType: match.image.mimeType,
			},
		}))

		// Gather every attachment source before any marker/registry mutation.
		// Retention merges a prior cancelled/intercepted submission: same draft
		// reuses retained attachments (no duplicate paths); a changed draft
		// refreshes path attachments while explicit incoming/pasted survive.
		const record = mergeRetainedSubmission({
			text: event.text,
			incoming,
			pending: pendingImages,
			pathMatches,
			retained: isInteractiveTui ? getRetainedSubmission() : null,
			generation: gateGeneration,
		})

		const totalImages = record.incoming.length + record.pasted.length + record.paths.size
		if (totalImages === 0) {
			if (isInteractiveTui) clearRetainedSubmission()
			if (suppressedPaths) consumePathSuppression(event.text, gateGeneration)
			return
		}

		if (isInteractiveTui && needsVisionSwitch(ctx.model)) {
			const outcome = await runVisionGate({ pi, ctx, event, record })
			if (outcome.kind === "handled") return { action: "handled" as const }
			if (outcome.kind === "remove") {
				if (suppressedPaths) consumePathSuppression(event.text, gateGeneration)
				// Original trimmed text, no images, no markers, no registry or
				// counter mutation. An empty text consumes the submission.
				const trimmed = event.text.trim()
				return trimmed ? { action: "transform" as const, text: trimmed, images: [] } : { action: "handled" as const }
			}
			// proceed: checked switch succeeded — submit on the new model below.
		}
		if (suppressedPaths) consumePathSuppression(event.text, gateGeneration)

		// Accepted submission: commit markers/registry/counter from the merged
		// record, transferring retained attachments into the transform exactly
		// once, then clear the retained record.
		const images = [...record.incoming, ...record.pasted, ...record.paths.values()]
		pendingImages = []
		updateIndicator()

		const startIndex = imageCounter + 1
		imageCounter += images.length
		// Persist each image to disk and register under its [Image #N] id.
		images.forEach((image, i) => {
			const id = startIndex + i
			addImage(id, image)
		})
		const prefix = buildImageMarkerPrefix(startIndex, images.length)
		const trimmed = event.text.trimStart()
		const text = trimmed ? `${prefix} ${trimmed}` : prefix
		clearRetainedSubmission()

		return { action: "transform" as const, text, images }
	})
}
