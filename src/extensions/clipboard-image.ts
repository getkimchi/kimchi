import { execFile } from "node:child_process"
import { extname, join } from "node:path"
import type { ImageContent } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getNativeClipboard } from "../utils/clipboard-native-harness.js"
import { readClipboardImage } from "../utils/clipboard-read.js"
import { addImage, clearAllImages, setImageCacheDir } from "../utils/image-registry.js"
import { IMAGE_EXT_TO_MIME } from "../utils/image-utils.js"
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
let isCheckingFinder = false
// Monotonic counter incremented on every session_start. Async callbacks
// capture the generation at launch and bail out if it no longer matches,
// preventing stale Finder checks from corrupting a newer session's state.
let sessionGeneration = 0

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
	// submit-time vision gate is the single choke point. A one-shot hint
	// tells the user a switch will be offered at send time.
	if (needsVisionSwitch(currentCtx?.model)) {
		currentCtx?.ui.notify(
			`⚠ ${currentCtx?.model?.id ?? "Current model"} is text-only — you'll be able to change to a vision model when sending`,
			"warning",
		)
	}
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
		sessionGeneration++
		isCheckingFinder = false
		currentCtx = ctx
		pendingImages = []
		imageCounter = 0
		// Reset the vision gate's retained state, suppressions, deferred latch,
		// and dialog ownership so a replacement session starts clean.
		resetVisionGateState()
		const sessionDir = ctx.sessionManager?.getSessionDir?.() ?? null
		const dir = sessionDir ? join(sessionDir, "image-cache") : null
		setImageCacheDir(dir)
		clearAllImages()
		updateIndicator()
		// Linux clipboard detection shells out to wl-paste/xclip, so keep it on-demand.
		// Polling wl-paste can create transient surfaces that steal focus on Wayland.
		if (process.platform !== "linux") {
			checkClipboard()
			clipboardPollId = setInterval(checkClipboard, CLIPBOARD_POLL_INTERVAL_MS)
		}
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
		resetVisionGateState()
	})

	pi.on("agent_end", (_event, ctx) => {
		// Deferred vision-gate dialog for streaming-intercepted submissions.
		visionGateOnAgentEnd(pi, ctx)
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
		const freshMatches = extractPaths ? extractTypedImagePaths(event.text, ctx.cwd ?? process.cwd()) : []
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
