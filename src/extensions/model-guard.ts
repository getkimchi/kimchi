import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai"
import {
	buildSessionContext,
	type ContextEvent,
	type ExtensionAPI,
	type ExtensionContext,
	estimateTokens as estimatePiMessageTokens,
} from "@earendil-works/pi-coding-agent"
import { getCompactionEnabled } from "../settings-watcher.js"
import { COMPACTION_RESERVE_TOKENS } from "./compaction-thresholds.js"
import { hasActiveFerment } from "./ferment/state.js"

/** Messages that have a content array we can inspect for images. */
type ContentMessage = UserMessage | AssistantMessage | ToolResultMessage

export const SAFETY_MARGIN = 0.95

export function getSafeContextWindow(contextWindow: number): number {
	return Math.floor(contextWindow * SAFETY_MARGIN)
}

export function contextFitsModel(tokens: number, contextWindow: number): boolean {
	return tokens <= getSafeContextWindow(contextWindow)
}

/**
 * Returns the best available token count for the current context.
 * Uses upstream getContextUsage().tokens as the provider-accurate baseline,
 * then estimates messages appended after that provider response. Falls back
 * to the local estimateTokens() heuristic when upstream returns null
 * (e.g. post-compaction, pre-first-response, fresh session).
 * Returns null when no data is available at all.
 */
export function resolveContextTokens(
	usage: { tokens: number | null } | undefined,
	messages: ContextEvent["messages"],
): number | null {
	if (messages.length === 0) return usage?.tokens ?? null

	// Upstream pi-coding-agent (>= 0.84.1) reports tokens: null after compaction
	// until a successful post-compaction assistant response exists, so a non-null
	// value is trustworthy. The null fallback below is compaction-boundary aware
	// (see estimateTokens).
	if (usage?.tokens == null) return estimateTokens(messages)

	const lastAssistantUsage = findLastAssistantUsage(messages)
	if (!lastAssistantUsage) return usage.tokens

	return usage.tokens + estimateTokensAfter(messages, lastAssistantUsage.index)
}

function findLastAssistantUsage(
	messages: ContextEvent["messages"],
): { index: number; totalTokens: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (message.role === "assistant" && "usage" in message && typeof message.usage?.totalTokens === "number") {
			return { index: i, totalTokens: message.usage.totalTokens }
		}
	}
	return undefined
}

function estimateTokensAfter(messages: ContextEvent["messages"], index: number): number {
	let tokens = 0
	for (let i = index + 1; i < messages.length; i++) tokens += estimateMessageTokens(messages[i])
	return tokens
}

/** Module-level flag tracking whether the current session contains image blocks. */
let imagesDetected = false

/** Module-level flag tracking whether images have been stripped for non-vision model compatibility. */
let imagesStripped = false

/** Tracks whether the turn_end mid-turn compaction guard triggered ctx.compact().
 *  Set before calling ctx.compact() and consumed by the session_compact handler
 *  so the notification runs against the fresh post-compaction ctx, not the stale
 *  one captured in the turn_end handler's closure. */
let pendingMidTurnCompaction = false

/** Reference to the latest context messages (stored for /strip-images command). */
let latestMessages: ContextEvent["messages"] = []

/** Timestamp of the last context event that updated latestMessages (ms since epoch). */
let latestMessagesTimestamp = 0

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

/**
 * Returns the timestamp (ms since epoch) of the most recent context event.
 * If no context event has fired yet, returns 0.
 */
export function getLatestMessagesTimestamp(): number {
	return latestMessagesTimestamp
}

function resetSessionState(): void {
	imagesDetected = false
	imagesStripped = false
	pendingMidTurnCompaction = false
	latestMessages = []
	latestMessagesTimestamp = 0
	imageDescriptions.clear()
}

/**
 * @internal Exported for unit tests — production code uses session_start/session_shutdown hooks.
 */
export const __resetImagesDetectedForTest = resetSessionState

/**
 * Rough token estimation: 4 chars per token for text, images counted separately.
 * Accumulates from assistant message usage when available for higher accuracy.
 *
 * Compaction-aware: when a compactionSummary message is present, kept tail
 * messages (entries before the compaction point, spliced after the summary by
 * buildContextEntries) still carry PRE-COMPACTION usage.totalTokens — e.g. the
 * final turn-end response reports the full ~270k pre-compaction context. Using
 * such a baseline reproduces the "stale 270k" rejection. We only trust an
 * assistant usage baseline when the assistant's timestamp is AFTER the
 * compaction summary's timestamp (i.e. it was generated on the compacted
 * context); otherwise we sum content from the summary onward.
 */
export function estimateTokens(messages: ContextEvent["messages"]): number {
	// Latest compaction boundary, if any. Kept-tail messages (entries kept from
	// before the compaction, spliced after the summary by buildContextEntries)
	// still carry PRE-COMPACTION usage.totalTokens — e.g. the final turn-end
	// response reports the full ~270k pre-compaction context. Such stale
	// baselines reproduce the "stale 270k" rejection, so an assistant usage
	// baseline is only trusted when the assistant's timestamp is AFTER the
	// latest compaction summary's timestamp.
	const boundary = compactionBoundary(messages)
	if (!boundary) {
		const lastAssistantUsage = findLastAssistantUsage(messages)
		return (lastAssistantUsage?.totalTokens ?? 0) + estimateTokensAfter(messages, lastAssistantUsage?.index ?? -1)
	}

	// Boundary present: only a post-summary assistant is a usable baseline.
	for (let i = messages.length - 1; i > boundary.index; i--) {
		const msg = messages[i]
		if (msg.role !== "assistant" || !("usage" in msg) || typeof msg.usage?.totalTokens !== "number") continue
		const ts = (msg as { timestamp?: unknown }).timestamp
		if (typeof ts !== "number" || ts <= boundary.timestamp) continue // stale kept-tail baseline
		return msg.usage.totalTokens + estimateTokensAfter(messages, i)
	}

	// No usable baseline: sum content from the summary onward (the summary's
	// own text included). Content is always counted — NEVER the stale usage of
	// kept-tail assistants — so large retained responses are not undercounted
	// (an undercount would let the guard accept a context that is too large
	// for the target model).
	let tokens = 0
	for (let i = boundary.index; i < messages.length; i++) tokens += estimateMessageContentTokens(messages[i])
	return tokens
}

/** Index and timestamp of the most recent compactionSummary message, if present. */
function compactionBoundary(messages: ContextEvent["messages"]): { index: number; timestamp: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as { role: string; timestamp?: unknown }
		if (msg.role === "compactionSummary") {
			return { index: i, timestamp: typeof msg.timestamp === "number" ? msg.timestamp : 0 }
		}
	}
	return undefined
}

/**
 * Content-only estimate for a single message. Usage metadata is NEVER read —
 * safe for kept-tail assistants with stale pre-compaction usage (see
 * estimateTokens).
 *
 * Image-capable roles (user/toolResult/custom) keep Kimchi's policy of 4 chars
 * per token for text and 1000 tokens per image. All other roles (assistant
 * text/thinking/toolCall arguments, summaries, bash executions) go through
 * Pi's public per-message estimator, which also ignores usage and counts the
 * full content — assistant messages contain no image blocks, so the image
 * policy is unaffected.
 */
function estimateMessageContentTokens(msg: ContextEvent["messages"][number]): number {
	if (msg.role === "user" || msg.role === "toolResult" || msg.role === "custom") {
		if (!("content" in msg)) return 0
		const content = (msg as ContentMessage).content
		if (typeof content === "string") return Math.ceil(content.length / 4)
		if (!Array.isArray(content)) return 0
		let tokens = 0
		for (const block of content) {
			if (block.type === "text") tokens += Math.ceil(block.text.length / 4)
			else if (block.type === "image") tokens += 1000
		}
		return tokens
	}
	return estimatePiMessageTokens(msg as Parameters<typeof estimatePiMessageTokens>[0])
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
	if (msg.role === "assistant" && "usage" in msg && typeof msg.usage?.totalTokens === "number") {
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
	_pi.on("session_start", resetSessionState)
	_pi.on("session_shutdown", resetSessionState)

	// ctx.compact() replaces the session internally, invalidating the ctx
	// captured in the turn_end handler. The session_compact event fires
	// afterwards with a fresh ctx, so we notify from there instead of from
	// the stale onComplete/onError closures.
	_pi.on("session_compact", async (event, ctx: ExtensionContext) => {
		// Refresh cached state so model-switch guards see post-compaction reality
		// immediately, rather than waiting for the next context event (which only
		// fires on the next LLM call). Without this, latestMessages still holds
		// pre-compaction messages (inflated token count) and imagesDetected stays
		// true even though the compaction summary is text-only.
		try {
			const branch = await Promise.resolve(ctx.sessionManager.getBranch())
			const postCompactMessages = buildSessionContext(branch).messages
			latestMessages = postCompactMessages
			latestMessagesTimestamp = Date.now()
			// Reset strip state only when no images survived compaction — Pi keeps a
			// recent tail after the summary and images in it remain in the active
			// context, so an unconditional reset would undo /strip-images for
			// images that are still present.
			imagesDetected = hasImages(postCompactMessages)
			if (!imagesDetected) {
				imagesStripped = false
				imageDescriptions.clear()
			}
		} catch (err) {
			// If we can't refresh (e.g. sessionManager not fully available),
			// the next context event will correct the state.
			console.warn("[model-guard] session_compact state refresh failed:", err)
		}

		// Only consume the flag for compactions triggered by this guard's
		// ctx.compact() call — not for /compact or threshold-triggered ones.
		if (!pendingMidTurnCompaction || !event.fromExtension) return
		pendingMidTurnCompaction = false
		ctx.ui?.notify(
			`Context compacted (${(event.compactionEntry.tokensBefore ?? 0).toLocaleString()} tokens → summary). Continue to resume.`,
			"info",
		)
	})

	_pi.on("context", async (event, ctx: ExtensionContext) => {
		const model = ctx.model
		const usage = ctx.getContextUsage()

		const messages = event.messages

		// Store reference to latest messages for /strip-images command
		latestMessages = messages
		latestMessagesTimestamp = Date.now()
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

		// Emergency truncation: only fires when the context was built against a larger
		// window than the current model accepts (e.g. session restored onto a smaller
		// model). In the normal same-model case usage.input is always < contextWindow
		// by API contract, so this never triggers and compaction handles growth instead.
		// Using the 95% safety-margin threshold here was wrong: it fired inside the
		// compaction zone, silently dropped history without a summary, and reset the
		// token estimate to ~20k — preventing compaction from triggering on the very
		// next turn.
		if (model) {
			const tokens = resolveContextTokens(usage, result)
			if (tokens != null && tokens > model.contextWindow) {
				const truncated = truncateMessages(result, model.contextWindow)
				if (truncated !== result) {
					result = truncated
					modified = true
				}
			}
		}

		if (modified) return { messages: result }
	})

	// Compaction mid-turn guard: upstream auto-compaction only checks the threshold
	// once per user turn (after agent.prompt() returns). In a long tool-call chain
	// the context can exceed the compaction threshold many times over before the
	// turn ends. turn_end fires after every individual LLM response inside the
	// loop, giving us a chance to compact before the hard limit is hit.
	_pi.on("turn_end", async (event, ctx: ExtensionContext) => {
		// Ferment-aware mid-turn compaction lives in the ferment extension
		// (src/extensions/ferment/auto-compaction.ts). It resumes the in-progress
		// step after compaction. Defer to it whenever a ferment is active so we
		// don't double-compact and so the ferment continues automatically.
		if (hasActiveFerment()) return

		const model = ctx.model
		if (!model) return

		const msg = event.message
		if (msg.role !== "assistant") return
		// Only act on tool-use responses — the turn is still in progress.
		// stop/error/aborted responses are already handled by _handlePostAgentRun.
		if (msg.stopReason !== "toolUse") return

		const usage = "usage" in msg ? msg.usage : undefined
		if (!usage?.totalTokens) return

		// Use the same threshold as upstream auto-compaction: contextWindow - reserveTokens.
		if (usage.totalTokens <= model.contextWindow - COMPACTION_RESERVE_TOKENS) return

		// /settings Auto-compact toggle (settings.json compaction.enabled).
		// ctx.compact() is upstream's manual path and does not check the toggle
		// itself, so this stopgap must gate on it explicitly — otherwise it
		// compacts even when the user (or a benchmark harness) disabled
		// auto-compaction. Project trust is already synced onto the settings
		// reader by settingsTrustSyncExtension at session_start.
		if (!getCompactionEnabled()) return

		// Threshold exceeded mid-turn. Compact now.
		//
		// NOTE: ctx.compact() is the manual compaction path which calls abort() on the
		// current agent run. This means the in-progress tool-call chain stops here and
		// the user must send another message to resume. This is worse UX than upstream
		// auto-compaction (which transparently retries via agent.continue()), but it is
		// the only option available from an extension — _runAutoCompaction and the
		// agent.continue() path are not exposed on ExtensionContext.
		//
		// The proper upstream fix is to wire _checkCompaction into the agent loop via
		// shouldStopAfterTurn or after_provider_response so compaction fires inside
		// the loop with transparent retry. This handler is a pragmatic stopgap.
		pendingMidTurnCompaction = true
		ctx.compact({
			// onComplete fires with a stale ctx after session replacement.
			// The actual notification is delivered via the session_compact event
			// handler above, which receives a fresh ctx.
			onError: (error) => {
				pendingMidTurnCompaction = false
				console.warn("[model-guard] mid-turn compaction failed:", error.message)
			},
		})
	})

	_pi.on("model_select", async () => {
		// model_select is handled entirely by model-switch.ts; model-guard only
		// registers vision and context guards on the context event.
	})
}

/**
 * Test-only helper to directly set latestMessages from tests.
 * Bypasses the context event so tests can control state without
 * needing to fire a context event or mock getLatestMessages.
 *
 * No-op in production; only mutates state when running under vitest.
 */
export function __setLatestMessagesForTest(messages: ContextEvent["messages"]): void {
	if (typeof process !== "undefined" && process.env?.VITEST) {
		latestMessages = messages
		latestMessagesTimestamp = Date.now()
	}
}
