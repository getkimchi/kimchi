import { join } from "node:path"
import type { ImageContent } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent"
import { getNativeClipboard } from "../utils/clipboard-native-harness.js"
import { readClipboardImage } from "../utils/clipboard-read.js"
import { droppedImagePathCandidate } from "../utils/dropped-image-path.js"
import { buildImageMarker, parseImageMarkers, stripImageMarkers } from "../utils/image-marker.js"
import { addImage, clearSessionImages, resolveImageContentById, setImageCacheDir } from "../utils/image-registry.js"
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
// Monotonic epoch bumped whenever pending attachments are cleared (accepted
// submit, gate remove, session replacement). handlePaste captures it before
// its async clipboard read and discards a stale completion — otherwise the
// late insert would drop an `[Image #N]` marker into a cleared editor and
// silently attach the image to the NEXT message.
let pasteEpoch = 0

/** Registry scope for this context's session (ids are per-session). */
function sessionIdOf(ctx: ExtensionContext | null): string {
	return ctx?.sessionManager?.getSessionId() ?? "default"
}

/** @internal — test hook resetting module state between unit tests. */
export function __resetClipboardImageForTest(): void {
	sessionSeen = false
	pendingImages = []
	removedDrops = new Map()
	imageCounter = 0
	inlineIdHighWater = 0
	currentCtx = null
	clipboardHasImage = false
	pasteEpoch = 0
}
// Per-session running counter of images attached to user turns. Resets on
// session_start so that a new conversation always begins at #1.
let imageCounter = 0
// Highest inline id assigned this session (draft or submit). Deleting a
// marker detaches its drop but never frees the number — a fresh drop must
// never collide with a live pending id (which would corrupt the registry:
// addImage would skip the file write but overwrite the entry's metadata).
let inlineIdHighWater = 0
function nextInlineId(): number {
	inlineIdHighWater = Math.max(inlineIdHighWater, imageCounter) + 1
	return inlineIdHighWater
}

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
	return ids.map(buildImageMarker).join(" ")
}

/**
 * The single detach/re-arm reconcile, used by the editor's markers-edited
 * channel AND by submit (a setEditorText restore bypasses that channel):
 * a pending drop whose `[Image #N]` marker vanished from the draft detaches
 * into `removedDrops` (the indicator follows the draft); a parked drop whose
 * marker is complete again re-arms into pending — unless a live pending drop
 * already owns that id (a re-typed marker is not an owner transfer).
 */
function reconcileInlineMarkers(present: Set<number>): void {
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
 * path. The number is monotonic for the session (nextInlineId), matching
 * the id the image receives at submit; a deleted marker's id is never reused.
 * The ui layer threads the session cwd in — drops never resolve against the
 * long-lived process cwd.
 */
setImageDropHandler((pastedText, cwd) => {
	const match = droppedImagePathCandidate(pastedText, cwd)
	if (!match) return false
	const base64 = Buffer.from(match.image.bytes).toString("base64")
	const n = nextInlineId()
	pendingImages.push({
		image: { type: "image", data: base64, mimeType: match.image.mimeType },
		inlineId: n,
		sourcePath: match.resolvedPath,
	})
	updateIndicator()
	insertTextAtPromptCursor(buildImageMarker(n))
	return true
})

/**
 * Marker-set sync: every edit that changes which `[Image #N]` markers are in
 * the draft (backspace, bulk delete, undo, kill-ring yank, plain typing) is
 * reported by the editor and reconciled live — see reconcileInlineMarkers.
 */
setImageMarkersEditedHandler(reconcileInlineMarkers)

async function handlePaste(): Promise<void> {
	// Capture before the async clipboard read: submitting (or replacing the
	// session) while the read is in flight clears pendingImages. Completing
	// anyway would insert `[Image #N]` into the cleared editor and silently
	// attach the image to the NEXT message — discard with a notice instead.
	const capturedCtx = currentCtx
	const capturedEpoch = pasteEpoch
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

	if (currentCtx !== capturedCtx || pasteEpoch !== capturedEpoch) {
		currentCtx?.ui?.notify("Clipboard image arrived too late — paste it again to attach it", "info")
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
	// Same inline-marker flow as editor drops: the paste takes a fresh
	// monotonic number up front and renders `[Image #N]` inline at the cursor,
	// so the draft shows the attachment instead of hiding it behind the
	// pending indicator. The number matches the id it receives at submit.
	const n = nextInlineId()
	pendingImages.push({ image: imageContent, inlineId: n })
	updateIndicator()
	insertTextAtPromptCursor(buildImageMarker(n))
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
			// Only the vision gate's "remove" outcome reaches this — the
			// attachments are gone for good, so prune their detached drops too:
			// a stale removedDrops entry would pin its base64 for the rest of
			// the session and re-arm on a later draft that mentions `[Image #N]`.
			pendingImages = []
			removedDrops = new Map()
			pasteEpoch++
			updateIndicator()
		},
	})

	pi.on("session_start", (event: SessionStartEvent, ctx) => {
		if (clipboardPollId !== null) {
			clearInterval(clipboardPollId)
			clipboardPollId = null
		}
		currentCtx = ctx
		// Only a REPLACEMENT session starts clean. The very first session_start
		// can fire moments AFTER the editor already accepted a paste/drop (the
		// prompt renders before the session finishes starting); clearing then
		// would silently lose attachments the user already made. An extension
		// reload re-fires session_start for the SAME session (reason "reload"):
		// resetting there would wipe live pending drops, restart numbering at
		// #1 (colliding with transcript markers) and delete the live image
		// cache — so "reload" never counts as a replacement.
		if (sessionSeen && event.reason !== "reload") {
			pendingImages = []
			removedDrops = new Map()
			imageCounter = 0
			inlineIdHighWater = 0
			pasteEpoch++
			// On-demand sessions never re-probe, so a hint left by a previous
			// proactive session would advertise an image that was not read again.
			clipboardHasImage = false
			// Reset the vision gate's retained state, suppressions, deferred latch,
			// and dialog ownership so a replacement session starts clean.
			resetVisionGateState()
			// Only the STARTING session's registry is cleared — the ACP server
			// shares this process across sessions, and a global wipe would
			// repoint another session's live markers at this session's images.
			clearSessionImages(sessionIdOf(ctx))
		}
		sessionSeen = true
		const sessionDir = ctx.sessionManager?.getSessionDir?.() ?? null
		const dir = sessionDir ? join(sessionDir, "image-cache") : null
		setImageCacheDir(sessionIdOf(ctx), dir)
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
		// Any interactive submission invalidates a clipboard read that is still
		// in flight: the draft it would complete into is cleared by this submit.
		if (isInteractiveTui) pasteEpoch++
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

		// A drop whose inline marker vanished from the submitted draft counts
		// as detached; a marker restored via a path that bypasses the editor's
		// edit channel (a setEditorText restore, e.g. an earlier gate cancel)
		// re-arms here. This runs BEFORE the gate outcome and BEFORE the
		// retained merge, so a cancelled gate cannot leave an entry
		// double-booked in pending+removed, and a re-armed entry flows into
		// the retained record for the cancel path.
		//
		// The marker machinery is TUI-only: `[Image #N]` drops and editor
		// markers exist only in the interactive TUI (insertTextAtPromptCursor
		// no-ops on ACP). Gating the reconcile/registry lookups keeps ACP input
		// events from re-attaching images for `[Image #N]` prose it types.
		const presentMarkers = isInteractiveTui ? parseImageMarkers(event.text) : new Set<number>()
		if (isInteractiveTui) reconcileInlineMarkers(presentMarkers)

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

		// Attach inline entries whose marker survived; entries without a
		// surviving marker stay parked in `removedDrops` (retained-record
		// copies of a previously cancelled attempt can reach here without
		// touching pendingImages). Keep these pending-sourced entries apart
		// from registry re-attachments below — a gate "remove" strips only the
		// pending ones' markers; a typed `[Image #N]` referencing a valid
		// earlier attachment must survive removal of an unrelated pending drop.
		const keptPending: PendingImage[] = []
		for (const p of record.pasted) {
			if (p.inlineId === null || presentMarkers.has(p.inlineId)) {
				keptPending.push(p)
			} else {
				removedDrops.set(p.inlineId, p)
			}
		}

		// A `[Image #N]` marker that matches neither a live drop nor a re-armed
		// one references an earlier turn's attachment: resolve it against the
		// on-disk registry so sending `[Image #3] describe it` re-attaches the
		// image the marker was sent with. Unknown ids stay plain text — but a
		// miss on a REGISTERED id means a lost attachment, which the user must
		// hear about instead of silently sending the marker alone.
		const registryAttached: PendingImage[] = []
		for (const id of presentMarkers) {
			if (keptPending.some((p) => p.inlineId === id)) continue
			const resolved = resolveImageContentById(sessionIdOf(ctx), id)
			if (resolved.kind === "ok") {
				registryAttached.push({ image: resolved.image, inlineId: id })
				continue
			}
			if (resolved.kind === "unknown") {
				// Most likely typed prose. One quiet log line; no UI noise.
				console.warn(`[clipboard-image] [Image #${id}] has no registered image for this session — leaving it as text`)
			} else {
				console.error(
					`[clipboard-image] [Image #${id}] could not be re-attached: ${
						resolved.kind === "missing-file" ? "cached file missing" : "cached file unreadable"
					} (${resolved.path})`,
					resolved.kind === "read-error" ? resolved.error : "",
				)
				currentCtx?.ui?.notify(`[Image #${id}] could not be attached — its cached image is gone`, "warning")
			}
		}
		const keptPasted: PendingImage[] = [...keptPending, ...registryAttached]

		const totalImages = record.incoming.length + keptPasted.length + record.paths.size
		if (totalImages === 0) {
			if (isInteractiveTui) {
				clearRetainedSubmission()
				// Same staleness prune as the accepted-submission branch below: an
				// image-free submit still closes every detached drop for good.
				removedDrops = new Map()
			}
			if (suppressedPaths) consumePathSuppression(event.text, gateGeneration)
			return
		}

		if (isInteractiveTui && needsVisionSwitch(ctx.model)) {
			const outcome = await runVisionGate({ pi, ctx, event, record })
			if (outcome.kind === "handled") return { action: "handled" as const }
			if (outcome.kind === "remove") {
				if (suppressedPaths) consumePathSuppression(event.text, gateGeneration)
				// Original trimmed text, no images, no registry or counter mutation.
				// Inline `[Image #N]` markers for the removed PENDING images are
				// stripped — they reference attachments that are gone. Markers
				// re-attached from the registry reference earlier turns' images
				// that still exist, so they stay. Typed path text stays in place
				// (existing behavior). An empty text consumes the submission.
				const inlineIds = keptPending.flatMap((p) => (p.inlineId === null ? [] : [p.inlineId]))
				const trimmed = stripImageMarkers(event.text, inlineIds).trim()
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
		// Accepted submission: detached drops are stale for good. Keeping them
		// would pin their base64 for the session's lifetime and let a later
		// draft containing the literal `[Image #N]` re-arm an image the user
		// deliberately detached (typing the marker as prose would attach it).
		removedDrops = new Map()
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
		const entries: { id: number; image: ImageContent }[] = prepared.map((p) => {
			let id: number
			if (p.inlineId !== null && presentMarkers.has(p.inlineId)) {
				id = p.inlineId
			} else {
				while (inlineTaken.has(nextFree)) nextFree++
				id = nextFree++
				prefixIds.push(id)
			}
			imageCounter = Math.max(imageCounter, id)
			addImage(sessionIdOf(ctx), id, p.image)
			return { id, image: p.image }
		})
		const prefix = buildImageMarkerPrefix(prefixIds)
		const trimmed = event.text.trimStart()
		const text = prefix ? (trimmed ? `${prefix} ${trimmed}` : prefix) : trimmed
		clearRetainedSubmission()

		// The wire format is text first, then image blocks in array order —
		// nothing explicitly binds a marker to its image, so the model pairs
		// them positionally (first marker in the text ← first image block).
		// Emit images in the order their markers first appear in the final
		// text so a draft that mentions markers out of attach order (or a
		// drop re-armed to the end of pendingImages after a delete+undo)
		// still attributes the right image to the right number.
		const byMarkerPosition = (e: { id: number }): number => {
			const pos = text.indexOf(buildImageMarker(e.id))
			return pos === -1 ? Number.MAX_SAFE_INTEGER : pos
		}
		const images = [...entries].sort((a, b) => byMarkerPosition(a) - byMarkerPosition(b)).map((e) => e.image)

		return { action: "transform" as const, text, images }
	})
}
