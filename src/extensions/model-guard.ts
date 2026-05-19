import type { ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai"
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getModelTier } from "./model-switch.js"
import { MODEL_CAPABILITIES } from "./orchestration/model-registry/builtin-models.js"

// ModelSelectEvent is not yet re-exported from pi-coding-agent index — define locally
type ModelSelectSource = "set" | "cycle" | "restore"
interface ModelSelectEvent {
	type: "model_select"
	model: { id: string; input: string[]; contextWindow: number }
	previousModel: { id: string; input: string[]; contextWindow: number } | undefined
	source: ModelSelectSource
}

const SAFETY_MARGIN = 0.95

/** Module-level flag tracking whether the current session contains image blocks. */
let imagesDetected = false

/**
 * Returns true if the most recent `context` event contained image blocks.
 * Updated automatically by the extension's `context` handler.
 */
export function sessionHasImages(): boolean {
	return imagesDetected
}

/**
 * Resets the module-level imagesDetected flag to false.
 * Exported exclusively for use in unit tests — do not call in production code.
 * @internal
 */
export function __resetImagesDetectedForTest(): void {
	imagesDetected = false
}

/**
 * Rough token estimation: 4 chars per token for text, images counted separately.
 * Accumulates from assistant message usage when available for higher accuracy.
 */
export function estimateTokens(messages: ContextEvent["messages"]): number {
	let tokens = 0
	for (const msg of messages) {
		// Use precise usage from assistant messages when available
		if (msg.role === "assistant" && "usage" in msg && msg.usage?.totalTokens) {
			tokens += msg.usage.totalTokens
			continue
		}
		// Fall back to char-based estimation
		const content = (msg as UserMessage).content
		if (typeof content === "string") {
			tokens += Math.ceil(content.length / 4)
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (block.type === "text") {
					tokens += Math.ceil(block.text.length / 4)
				} else if (block.type === "image") {
					// Conservative overestimate — a typical screenshot is ~1k tokens
					tokens += 1000
				}
			}
		}
	}
	return tokens
}

/**
 * Detect whether any message in the array contains ImageContent blocks.
 */
export function hasImages(messages: ContextEvent["messages"]): boolean {
	for (const msg of messages) {
		const content = (msg as UserMessage).content
		if (typeof content === "string") continue
		if (Array.isArray(content)) {
			for (const block of content) {
				if (block.type === "image") return true
			}
		}
	}
	return false
}

/**
 * Replace ImageContent blocks with text placeholders, preserving message shape.
 * Returns the original reference when there is nothing to strip.
 */
export function stripImages(messages: ContextEvent["messages"]): ContextEvent["messages"] {
	let changed = false
	const result = messages.map((msg) => {
		const content = (msg as UserMessage).content
		if (typeof content === "string") return msg
		if (!Array.isArray(content)) return msg

		const stripped = content.map((block) => {
			if (block.type === "image") {
				changed = true
				const img = block as ImageContent
				const placeholder: TextContent = {
					type: "text",
					text: `[image placeholder: ${img.mimeType ?? "image"} (base64, omitted for non-vision model)]`,
				}
				return placeholder
			}
			return block
		})

		if (!changed) return msg
		return { ...msg, content: stripped }
	})

	return changed ? (result as ContextEvent["messages"]) : messages
}

const TRUNCATE_NOTICE = "⚠️ Context truncated to fit model context window.\n\n"

/**
 * Drop the oldest messages until the estimated token count fits within maxTokens.
 * Preserves at least the last 2 messages unconditionally.
 * Returns the original reference when nothing is truncated.
 */
export function truncateMessages(messages: ContextEvent["messages"], maxTokens: number): ContextEvent["messages"] {
	const noticeTokens = Math.ceil(TRUNCATE_NOTICE.length / 4)
	const effectiveMax = Math.floor(maxTokens * SAFETY_MARGIN) - noticeTokens

	if (estimateTokens(messages) <= effectiveMax) return messages
	if (messages.length <= 2) return messages

	// Walk backwards to find the smallest index i such that messages[i..] fits
	// within effectiveMax AND has at least 2 messages. Start from the minimum
	// cutoff that preserves 2 messages (length - 2).
	let cutoff = messages.length
	for (let i = messages.length - 2; i >= 0; i--) {
		const candidate = messages.slice(i)
		if (estimateTokens(candidate) <= effectiveMax) {
			cutoff = i
			break
		}
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
	_pi.on("context", async (event, ctx: ExtensionContext) => {
		const model = ctx.model
		const usage = ctx.getContextUsage()

		const messages = event.messages

		// Always update the session-level image flag before any other processing
		imagesDetected = hasImages(messages)

		let modified = false
		let result = messages

		// Strip images when target model does not support vision input
		if (model && !model.input.includes("image")) {
			if (imagesDetected) {
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

	_pi.registerCommand("strip-images", {
		description: "Remove all images from the conversation so non-vision models can process it",
		handler: async (_args, ctx) => {
			if (!sessionHasImages()) {
				ctx.ui.notify("No images in session — nothing to strip.", "info")
				return
			}
			ctx.ui.notify("Stripping images from context…", "info")
			await ctx.compact()
			ctx.ui.notify("Images removed. The conversation can now be processed by models without vision input.", "info")
		},
	})

	_pi.on("model_select", async (event: ModelSelectEvent, ctx: ExtensionContext) => {
		// Skip restore events — these are automatic reversions, not user-initiated
		if (event.source === "restore") return

		const model = ctx.model

		// Guard 1: context overflow — warn when current tokens exceed 90% of target
		const usage = ctx.getContextUsage()
		if (model && usage?.tokens != null && usage.tokens > model.contextWindow * 0.9) {
			ctx.ui.notify(
				`Current context (${usage.tokens.toLocaleString()} tokens) exceeds 90% of "${model.id}" context window (${model.contextWindow.toLocaleString()} tokens). Use /compact to reduce context size.`,
				"warning",
			)
		}

		// Guard 2: vision incompatibility — warn when switching away from a vision model
		// while session contains images (they would be stripped)
		if (sessionHasImages() && model && !model.input.includes("image")) {
			ctx.ui.notify(`Switching to "${model.id}" will strip images since it does not support vision input.`, "warning")
		}

		// Guard 3: tier downgrade — warn when switching to a lower reasoning tier
		if (event.previousModel) {
			const prevTier = getModelTier(event.previousModel as never, MODEL_CAPABILITIES)
			const nextTier = getModelTier(model as never, MODEL_CAPABILITIES)
			if (prevTier && nextTier) {
				const TIER_ORDER = ["light", "standard", "heavy"]
				const prevIdx = TIER_ORDER.indexOf(prevTier)
				const nextIdx = TIER_ORDER.indexOf(nextTier)
				if (prevIdx > nextIdx) {
					ctx.ui.notify(
						`Switching from ${prevTier} → ${nextTier} tier. Reasoning and planning quality may be reduced.`,
						"info",
					)
				}
			}
		}
	})
}
