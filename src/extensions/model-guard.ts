import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai"
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

/** Messages that have a content array we can inspect for images. */
type ContentMessage = UserMessage | AssistantMessage | ToolResultMessage

export const SAFETY_MARGIN = 0.95

export function getSafeContextWindow(contextWindow: number): number {
	return Math.floor(contextWindow * SAFETY_MARGIN)
}

export function contextFitsModel(tokens: number, contextWindow: number): boolean {
	return tokens <= getSafeContextWindow(contextWindow)
}

/** Module-level flag tracking whether the current session contains image blocks. */
let imagesDetected = false

/** Module-level flag tracking whether images have been stripped for non-vision model compatibility. */
let imagesStripped = false

/** Reference to the latest context messages (stored for /strip-images command). */
let latestMessages: ContextEvent["messages"] = []

/** Map storing image descriptions keyed by data hash (for replacing images with descriptions). */
const imageDescriptions = new Map<string, string>()

/**
 * Returns true if the most recent `context` event contained image blocks.
 * Updated automatically by the extension's `context` handler.
 * Returns false if images have been stripped (conceptually gone).
 */
export function sessionHasImages(): boolean {
	return imagesDetected && !imagesStripped
}

/**
 * Marks images as stripped for the current session.
 * Called by the /strip-images command after processing.
 * After calling this, sessionHasImages() returns false and the context handler will apply stripping.
 */
export function markImagesAsStripped(): void {
	imagesStripped = true
}

/**
 * Stores a text description for an image, keyed by its data hash.
 * Used by the context handler to replace image blocks with their descriptions.
 */
export function storeImageDescription(dataHash: string, description: string): void {
	imageDescriptions.set(dataHash, description)
}

/**
 * Computes a hash from image data for consistent lookup.
 * Uses base64 data directly as the key (sufficient for our purposes).
 */
export function getImageDataHash(imageData: string): string {
	return `img_${imageData.slice(0, 32)}_${imageData.length}`
}

/**
 * Returns the latest context messages reference.
 * Used by the /strip-images command to process images.
 */
export function getLatestMessages(): ContextEvent["messages"] {
	return latestMessages
}

function resetImageState(): void {
	imagesDetected = false
	imagesStripped = false
	latestMessages = []
	imageDescriptions.clear()
}

/**
 * @internal Exported for unit tests — production code uses session_start/session_shutdown hooks.
 */
export const __resetImagesDetectedForTest = resetImageState

/**
 * Rough token estimation: 4 chars per token for text, images counted separately.
 * Accumulates from assistant message usage when available for higher accuracy.
 */
export function estimateTokens(messages: ContextEvent["messages"]): number {
	let lastAssistantIdx = -1
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg.role === "assistant" && "usage" in msg && msg.usage?.totalTokens) {
			lastAssistantIdx = i
			break
		}
	}

	let tokens = 0

	if (lastAssistantIdx >= 0) {
		const lastAssistant = messages[lastAssistantIdx]
		tokens = (lastAssistant as AssistantMessage).usage?.totalTokens ?? 0
	}

	for (let i = lastAssistantIdx >= 0 ? lastAssistantIdx + 1 : 0; i < messages.length; i++) {
		const msg = messages[i]
		if (msg.role === "assistant" && "usage" in msg && msg.usage?.totalTokens) continue
		if (!("content" in msg)) continue
		const content = (msg as ContentMessage).content
		if (typeof content === "string") {
			tokens += Math.ceil(content.length / 4)
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (block.type === "text") {
					tokens += Math.ceil(block.text.length / 4)
				} else if (block.type === "image") {
					tokens += 1000
				}
			}
		}
	}
	return tokens
}

/**
 * Detect whether any message in the array contains ImageContent blocks.
 * Checks all message types (user messages, tool results, etc.).
 */
export function hasImages(messages: ContextEvent["messages"]): boolean {
	for (const msg of messages) {
		if (!("content" in msg)) continue
		const content = (msg as ContentMessage).content
		if (typeof content === "string") continue
		if (Array.isArray(content)) {
			for (const block of content) {
				if (block.type === "image") return true
			}
		}
	}
	return false
}

function hasUndescribedImages(messages: ContextEvent["messages"]): boolean {
	for (const msg of messages) {
		if (!("content" in msg)) continue
		const content = (msg as ContentMessage).content
		if (typeof content === "string") continue
		if (Array.isArray(content)) {
			for (const block of content) {
				if (block.type === "image") {
					const hash = getImageDataHash((block as ImageContent).data)
					if (!imageDescriptions.has(hash)) return true
				}
			}
		}
	}
	return false
}

/**
 * Replace ImageContent blocks with text placeholders or descriptions, preserving message shape.
 * Returns the original reference when there is nothing to strip.
 * If an image description was stored via storeImageDescription(), uses that instead of placeholder.
 */
export function stripImages(messages: ContextEvent["messages"]): ContextEvent["messages"] {
	let anyChanged = false
	const result = messages.map((msg) => {
		if (!("content" in msg)) return msg
		const content = (msg as ContentMessage).content
		if (typeof content === "string") return msg
		if (!Array.isArray(content)) return msg
		if (!content.some((block) => block.type === "image")) return msg

		const stripped = content.map((block) => {
			if (block.type !== "image") return block
			const img = block as ImageContent
			const hash = getImageDataHash(img.data)
			const description = imageDescriptions.get(hash)
			const text: string = description
				? `[Image description: ${description}]`
				: `[image removed: ${img.mimeType ?? "image"} — stripped for non-vision model compatibility]`
			return { type: "text", text } as TextContent
		})

		anyChanged = true
		return { ...msg, content: stripped }
	})

	return anyChanged ? (result as ContextEvent["messages"]) : messages
}

const TRUNCATE_NOTICE = "⚠️ Context truncated to fit model context window.\n\n"

/**
 * Drop the oldest messages until the estimated token count fits within maxTokens.
 * Preserves at least the last 2 messages unconditionally.
 * Returns the original reference when nothing is truncated.
 */
export function estimateMessageTokens(msg: ContextEvent["messages"][number]): number {
	if (msg.role === "assistant" && "usage" in msg && msg.usage?.totalTokens) {
		return msg.usage.totalTokens
	}
	if (!("content" in msg)) return 0
	const content = (msg as ContentMessage).content
	if (typeof content === "string") return Math.ceil(content.length / 4)
	if (!Array.isArray(content)) return 0
	let t = 0
	for (const block of content) {
		if (block.type === "text") t += Math.ceil(block.text.length / 4)
		else if (block.type === "image") t += 1000
	}
	return t
}

export function truncateMessages(messages: ContextEvent["messages"], maxTokens: number): ContextEvent["messages"] {
	const noticeTokens = Math.ceil(TRUNCATE_NOTICE.length / 4)
	const effectiveMax = Math.floor(maxTokens * SAFETY_MARGIN) - noticeTokens

	if (estimateTokens(messages) <= effectiveMax) return messages
	if (messages.length <= 2) return messages

	let runningTokens = 0
	let cutoff = messages.length - 2

	for (let i = messages.length - 1; i >= 0; i--) {
		runningTokens += estimateMessageTokens(messages[i])
		if (runningTokens > effectiveMax) {
			cutoff = Math.min(Math.max(i + 1, 0), messages.length - 2)
			break
		}
		cutoff = i
	}

	const pruned = messages.slice(cutoff)
	if (pruned.length === messages.length) return messages

	const noticeMsg: UserMessage = {
		role: "user",
		content: TRUNCATE_NOTICE,
		timestamp: 0,
	}

	return [noticeMsg, ...pruned] as ContextEvent["messages"]
}

export default function createModelGuardExtension(_pi: ExtensionAPI) {
	_pi.on("session_start", resetImageState)
	_pi.on("session_shutdown", resetImageState)

	_pi.on("context", async (event, ctx: ExtensionContext) => {
		const model = ctx.model
		const usage = ctx.getContextUsage()

		const messages = event.messages

		// Store reference to latest messages for /strip-images command
		latestMessages = messages

		// Always scan for images in the current context.
		// If new images appear after a previous strip, reset the stripped flag
		// so the guards re-engage for the fresh images.
		const currentlyHasImages = hasImages(messages)
		if (imagesStripped && currentlyHasImages && hasUndescribedImages(messages)) {
			imagesStripped = false
			imageDescriptions.clear()
		}
		imagesDetected = currentlyHasImages

		let modified = false
		let result = messages

		// Strip images when: (a) target model does not support vision input, OR (b) imagesStripped flag is set
		if (imagesStripped || (model && !model.input.includes("image"))) {
			if (hasImages(result)) {
				result = stripImages(result)
				modified = true
			}
		}

		// Truncate when context usage exceeds the target model's context window
		if (model && usage?.tokens != null) {
			const threshold = Math.floor(model.contextWindow * SAFETY_MARGIN)
			if (usage.tokens > threshold) {
				const truncated = truncateMessages(result, model.contextWindow)
				if (truncated !== result) {
					result = truncated
					modified = true
				}
			}
		}

		if (modified) return { messages: result }
	})
}
