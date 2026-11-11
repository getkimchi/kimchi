/**
 * Defensive undecodable-image sanitizer: guarantees no image whose bytes are
 * not a decodable PNG/JPEG/GIF/WEBP is ever sent to a provider. Paste-time
 * validation (clipboard-read.ts) only covers new pastes; persisted history
 * (previously poisoned sessions, ACP/IDE attachments) is neutralized here on
 * every outgoing request, on both TUI and ACP surfaces. Mirrors
 * orphan-tool-result-sanitizer.ts as the last line of defense.
 *
 * Contract: `before_provider_request` carries the PROVIDER-REQUEST params
 * built by pi-ai (core/sdk.js `onPayload` receives buildParams output — the
 * final chat-completions body, not pi-ai Message[]). Image blocks therefore
 * come in provider shapes: openai-completions
 * `{ type: "image_url", image_url: { url } }` (data URLs; remote https left
 * untouched), anthropic-style `{ type: "image", source: { type: "base64",
 * data } }`, and flat pi-ai ImageContent (defensive).
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { sniffImageMimeType } from "../utils/image-utils.js"

/** Text block that replaces an undecodable image block. */
export const IMAGE_REMOVED_NOTE = "[image removed: corrupt or unsupported image data]"

/**
 * Extract the base64 payload from an outgoing image content block, in any of
 * the provider shapes the hook sees. Returns `null` for non-image blocks and
 * for remote URLs (nothing local to sniff — those are left untouched).
 */
export function base64OfImageBlock(block: unknown): string | null {
	if (!block || typeof block !== "object") return null
	const b = block as Record<string, unknown>
	if (b.type === "image_url" && b.image_url && typeof b.image_url === "object") {
		const url = (b.image_url as Record<string, unknown>).url
		if (typeof url !== "string" || !url.startsWith("data:")) return null
		return url.slice(url.indexOf(",") + 1)
	}
	if (b.type === "image") {
		const source = b.source as Record<string, unknown> | undefined
		const value = source && typeof source.data === "string" ? source.data : b.data
		if (typeof value !== "string") return null
		if (value.startsWith("data:")) return value.slice(value.indexOf(",") + 1)
		return value
	}
	return null
}

/**
 * Replace every undecodable image block in `messages` with the text note.
 * Pure, total, never throws: unknown shapes are skipped defensively. Shares
 * the sniff with the clipboard gate — do not duplicate.
 */
export function stripUndecodableImages(messages: ReadonlyArray<unknown>): number {
	let replaced = 0
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue
		const content = (raw as { content?: unknown }).content
		if (!Array.isArray(content)) continue
		for (let i = 0; i < content.length; i++) {
			const base64 = base64OfImageBlock(content[i])
			if (base64 === null) continue
			// 32 base64 chars decode to 24 bytes — more than the longest signature (12).
			if (sniffImageMimeType(Buffer.from(base64.slice(0, 32), "base64")) !== null) continue
			content[i] = { type: "text", text: IMAGE_REMOVED_NOTE }
			replaced++
		}
	}
	return replaced
}

/** Registers a `before_provider_request` handler that replaces undecodable
 *  image blocks in the outgoing request with a text note. Drop-silent (debug
 *  log only), provider-agnostic: runs on both TUI and ACP surfaces. */
const undecodableImageSanitizerExtension: ExtensionFactory = (pi: ExtensionAPI) => {
	pi.on("before_provider_request", (event: unknown) => {
		const payload = (event as Record<string, unknown> | null)?.payload as Record<string, unknown> | null
		if (!payload || !Array.isArray(payload.messages)) return
		const replaced = stripUndecodableImages(payload.messages)
		if (replaced === 0) return
		console.debug(`[image-sanitizer] replaced ${replaced} undecodable image block(s) in outgoing request`)
		return payload
	})
}

export default undecodableImageSanitizerExtension
