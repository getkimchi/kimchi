import { join } from "node:path"
import type { ImageContent } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getNativeClipboard } from "../utils/clipboard-native-harness.js"
import { readClipboardImage } from "../utils/clipboard-read.js"
import { droppedImagePathCandidate } from "../utils/dropped-image-path.js"
import { addImage, clearAllImages, getImageContentById, setImageCacheDir } from "../utils/image-registry.js"
import { extractTypedImagePaths } from "../utils/typed-image-paths.js"
import {
	insertTextAtPromptCursor,
	setImageDropHandler,
	setImageMarkersEditedHandler,
	setPasteImageHandler,
	setPendingImageIndicator,
} from "./ui.js"
import {
	clearRetained as clearRetainedSubmission,
	consumePathSuppression,
	getPathSuppression,
	getRetainedSubmission,
	getVisionGateSessionGeneration,
	mergeRetainedSubmission,
	type PathAttachment,
	type PendingImage,
	registerVisionGateSideEffects,
	resetVisionGateState,
	runVisionGate,
	visionGateOnAgentEnd,
} from "./vision-gate.js"
import { modelSupportsImages, needsVisionSwitch } from "./vision-support.js"

let pendingImages: PendingImage[] = []
// Dropped images the user detached by deleting their inline `[Image #N]`
// marker. Remembered (keyed by the marker number) so a marker that becomes
// complete again — e.g. via undo — re-arms the attachment at submit.
let removedDrops: Map<number, PendingImage> = new Map()
let currentCtx: ExtensionContext | null = null
// Whether any session_start has fired in this process. The first one must
// not wipe pending state (drops/pastes can predate it); only replacement
// sessions reset.
let sessionSeen = false

/** @internal — test hook resetting module state between unit tests. */
export function __resetClipboardImageForTest(): void {
	sessionSeen = false
	pendingImages = []
	removedDrops = new Map()
	imageCounter = 0
	currentCtx = null
	clipboardHasImage = false
}
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

function buildImageMarkerPrefix(ids: number[]): string {
	if (ids.length === 0) return ""
	return ids.map((id) => `[Image #${id}]`).join(" ")
}

/** `[Image #N]` tokens present in a draft, keyed for inline-marker lookup. */
function inlineMarkersInText(text: string): Set<number> {
	const markers = new Set<number>()
	for (const m of text.matchAll(/\[Image #(\d+)\]/g)) markers.add(Number(m[1]))
	return markers
}

/** Remove the `[Image #N]` tokens for the given ids from `text` (one trailing space each). */
function stripInlineMarkers(text: string, ids: number[]): string {
	if (ids.length === 0) return text
	const re = new RegExp(`\\[Image #(?:${ids.join("|")})\\] ?`, "g")
	return text.replace(re, "")
}

setPasteImageHandler(() => {
	handlePaste().catch((err) => {
		console.error("Clipboard paste handler error:", err)
	})
})

/**
 * File-drop paste: a terminal drag-and-drop arrives as a bracketed paste of
 * the file path. When it is a single readable local image, consume the paste
 * and render `[Image #N]` inline at the drop position instead of the raw
 * path. The number continues the session's image sequence (imageCounter +
 * pending), matching the id the image receives at submit.
 */
setImageDropHandler((pastedText) => {
	const match = droppedImagePathCandidate(pastedText, currentCtx?.cwd ?? process.cwd())
	if (!match) return false
	const base64 = Buffer.from(match.image.bytes).toString("base64")
	const n = imageCounter + pendingImages.length + 1
	pendingImages.push({
		image: { type: "image", data: base64, mimeType: match.image.mimeType },
		inlineId: n,
		sourcePath: match.resolvedPath,
	})
	// A fresh drop is the canonical owner of its number — any older detached
	// entry with the same id must not be re-armed alongside it.
	removedDrops.delete(n)
	updateIndicator()
	insertTextAtPromptCursor(`[Image #${n}]`)
	return true
})

/**
 * Marker-set sync: every edit that changes which `[Image #N]` markers are in
 * the draft (backspace, bulk delete, undo, kill-ring yank, plain typing) is
 * reported by the editor. A pending drop whose marker vanished detaches
 * immediately (parking in `removedDrops` so the indicator empties at once);
 * a marker that becomes complete again — e.g. undo fully restoring it —
 * re-arms its drop right away instead of waiting for submit.
 */
setImageMarkersEditedHandler((present) => {
	let changed = false
	for (let i = pendingImages.length - 1; i >= 0; i--) {
		const p = pendingImages[i]
		if (p && p.inlineId !== null && !present.has(p.inlineId)) {
			pendingImages.splice(i, 1)
			removedDrops.set(p.inlineId, p)
			changed = true
		}
	}
	for (const [id, entry] of [...removedDrops]) {
		if (present.has(id) && !pendingImages.some((p) => p.inlineId === id)) {
			pendingImages.push(entry)
			removedDrops.delete(id)
			changed = true
		}
	}
	if (changed) updateIndicator()
})

async function handlePaste(): Promise<void> {
	const { clipboard: native, error } = getNativeClipboard()
	if (!native && !process.env.KIMCHI_TUI_E2E_CLIPBOARD_IMAGE) {
		const detail = error ? `: ${error}` : ""
		currentCtx?.ui?.notify(`Clipboard image support is not available${detail}`, "warning")
		return
	}

	let image: { bytes: Uint8Array; mimeType: string; degraded?: boolean } | null
	try {
		image = await readClipboardImage()
	} catch (err) {
		// The pasteboard advertises an image (so the indicator shows) but the
		// bytes cannot be decoded — corrupt or unsupported image data. "Support
		// is not available" would be misleading: support works, this image does
		// not. Log the underlying error; it is invisible in the TUI otherwise.
		console.error("[clipboard-image] Failed to read clipboard image:", err)
		currentCtx?.ui?.notify("Clipboard image could not be read — corrupt or unsupported image data", "warning")
		return
	}

	if (!image) {
		currentCtx?.ui?.notify("No image found on clipboard", "info")
		return
	}

	// The bytes came from the pasteboard's own representation because the
	// Finder-copied file could not be read — they may be a thumbnail or a
	// rendering (e.g. page 1 of a PDF) rather than the original file.
	if (image.degraded) {
		currentCtx?.ui?.notify("Pasted a lower-quality preview — the original file could not be read", "info")
	}

	const base64 = Buffer.from(image.bytes).toString("base64")
	const imageContent: ImageContent = {
		type: "image",
		data: base64,
		mimeType: image.mimeType,
	}
	// Same inline-marker flow as editor drops: the paste takes the session's
	// next number up front and renders `[Image #N]` inline at the cursor, so
	// the draft shows the attachment instead of hiding it behind the pending
	// indicator. The number continues the session sequence (imageCounter +
	// pending), matching the id the image receives at submit.
	const n = imageCounter + pendingImages.length + 1
	pendingImages.push({ image: imageContent, inlineId: n })
	updateIndicator()
	insertTextAtPromptCursor(`[Image #${n}]`)
	// Paste is accepted regardless of the current model's capabilities — the
	// submit-time vision gate is the single choke point. The text-only hint
	// rides the pending-image indicator (not a chat warning, which cannot be
	// retracted once the model switches): it clears itself on model_select.
}

function updateIndicator(): void {
	const count = pendingImages.length
	if (count > 0) {
		const totalRawBytes = pendingImages.reduce((sum, img) => sum + Math.floor((img.image.data.length * 3) / 4), 0)
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
		// Only a REPLACEMENT session starts clean. The very first session_start
		// can fire moments AFTER the editor already accepted a paste/drop (the
		// prompt renders before the session finishes starting); clearing then
		// would silently lose attachments the user already made.
		if (sessionSeen) {
			pendingImages = []
			removedDrops = new Map()
			imageCounter = 0
			// On-demand sessions never re-probe, so a hint left by a previous
			// proactive session would advertise an image that was not read again.
			clipboardHasImage = false
			// Reset the vision gate's retained state, suppressions, deferred latch,
			// and dialog ownership so a replacement session starts clean.
			resetVisionGateState()
			clearAllImages()
		}
		sessionSeen = true
		const sessionDir = ctx.sessionManager?.getSessionDir?.() ?? null
		const dir = sessionDir ? join(sessionDir, "image-cache") : null
		setImageCacheDir(dir)
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

		// A drop whose inline `[Image #N]` marker is no longer in the draft
		// counts as detached: it parks in `removedDrops` (indicator-consistent,
		// no silent re-attach). Conversely, a removed drop whose marker is
		// complete again — e.g. undo fully restored it — re-arms here.
		const presentMarkers = inlineMarkersInText(event.text)
		const keptPasted: PendingImage[] = []
		for (const p of record.pasted) {
			if (p.inlineId === null || presentMarkers.has(p.inlineId)) {
				keptPasted.push(p)
			} else {
				removedDrops.set(p.inlineId, p)
			}
		}
		for (const [id, entry] of [...removedDrops]) {
			// Skip ids already owned by a live pending drop (a re-drop of the
			// same number after a deletion) — otherwise the image attaches twice.
			if (presentMarkers.has(id) && !keptPasted.some((p) => p.inlineId === id)) {
				keptPasted.push(entry)
				removedDrops.delete(id)
			}
		}

		// A `[Image #N]` marker that matches neither a live drop nor a re-armed
		// one references an earlier turn's attachment: resolve it against the
		// on-disk registry so sending `[Image #3] describe it` re-attaches the
		// image the marker was sent with. Unknown ids stay plain text.
		for (const id of presentMarkers) {
			if (keptPasted.some((p) => p.inlineId === id)) continue
			const image = getImageContentById(id)
			if (image) keptPasted.push({ image, inlineId: id })
		}

		const totalImages = record.incoming.length + keptPasted.length + record.paths.size
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
				// Original trimmed text, no images, no registry or counter mutation.
				// Inline `[Image #N]` markers for the removed pending images are
				// stripped too — they reference attachments that are gone. Typed
				// path text stays in place (existing behavior). An empty text
				// consumes the submission.
				const inlineIds = keptPasted.flatMap((p) => (p.inlineId === null ? [] : [p.inlineId]))
				const trimmed = stripInlineMarkers(event.text, inlineIds).trim()
				return trimmed ? { action: "transform" as const, text: trimmed, images: [] } : { action: "handled" as const }
			}
			// proceed: checked switch succeeded — submit on the new model below.
		}
		if (suppressedPaths) consumePathSuppression(event.text, gateGeneration)

		// Accepted submission: commit markers/registry/counter from the merged
		// record, transferring retained attachments into the transform exactly
		// once, then clear the retained record. Attachment order is unchanged
		// (incoming, pasted, typed paths).
		const prepared: { image: ImageContent; inlineId: number | null }[] = [
			...record.incoming.map((image) => ({ image, inlineId: null })),
			...keptPasted.map((p) => ({ image: p.image, inlineId: p.inlineId })),
			...[...record.paths.values()].map((image) => ({ image, inlineId: null })),
		]
		pendingImages = []
		updateIndicator()

		// An inline `[Image #N]` marker still present in the draft keeps the
		// number it was assigned at paste/drop time — the id the user saw in
		// the editor is the id the image is registered under, and no prefix
		// marker is duplicated in front of the text. Everything without an
		// inline number (upstream incoming images, typed paths) is
		// prefix-numbered from the session counter, skipping numbers claimed
		// by inline markers.
		// Every marker id mentioned in the draft is claimed — including typed
		// markers that resolved via the registry or matched nothing at all —
		// so prefix-numbered attachments never collide with visible markers.
		const inlineTaken = new Set<number>(presentMarkers)
		let nextFree = imageCounter + 1
		const prefixIds: number[] = []
		const images: ImageContent[] = prepared.map((p) => {
			let id: number
			if (p.inlineId !== null && presentMarkers.has(p.inlineId)) {
				id = p.inlineId
			} else {
				while (inlineTaken.has(nextFree)) nextFree++
				id = nextFree++
				prefixIds.push(id)
			}
			imageCounter = Math.max(imageCounter, id)
			addImage(id, p.image)
			return p.image
		})
		const prefix = buildImageMarkerPrefix(prefixIds)
		const trimmed = event.text.trimStart()
		const text = prefix ? (trimmed ? `${prefix} ${trimmed}` : prefix) : trimmed
		clearRetainedSubmission()

		return { action: "transform" as const, text, images }
	})
}
