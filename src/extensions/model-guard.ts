import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai"
import {
	buildSessionContext,
	type ContextEvent,
	type ExtensionAPI,
	type ExtensionContext,
	estimateTokens as estimatePiMessageTokens,
} from "@earendil-works/pi-coding-agent"
import { getCompactionEnabled } from "../settings-watcher.js"
import { isToolCallInFlight } from "../tool-call-in-flight.js"
import { INLINE_COMPACT_IN_PROGRESS_MESSAGE } from "../upstream-inline-compact-patch.js"
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

/** Mid-turn compaction attempt state, scoped to the current session generation.
 *  Ownership lives in the turn_end handler — the awaited inline adapter keeps
 *  the compaction inside the awaited agent run, so no detached task can
 *  outlive the prompt that print mode awaits. */
interface MidTurnCompactionState {
	/** An inline compaction attempt is executing inside this turn_end handler. */
	inFlight: boolean
	/** A successful compaction awaits provider-usage validation on the next
	 *  successful assistant response with positive usage. */
	awaitingValidation: boolean
	/** Mid-turn attempts are suppressed for the current pressure episode
	 *  (failed or ineffective compaction, or the adapter is unavailable). */
	suppressed: boolean
	/** One-shot diagnostic for the adapter-unavailable case. */
	adapterMissingDiagnosed: boolean
}

const midTurnCompaction: MidTurnCompactionState = {
	inFlight: false,
	awaitingValidation: false,
	suppressed: false,
	adapterMissingDiagnosed: false,
}

/** Session generation token: bumped on session_start/session_shutdown so a
 *  late compaction completion cannot notify or mutate a replacement session. */
let sessionGeneration = 0

/** Persist a concise mid-turn compaction outcome so headless archives (where
 *  ui.notify is a no-op) explain what the guard did. Best-effort: appending
 *  an entry must never break the compaction handler. */
function appendMidTurnDiagnostic(pi: ExtensionAPI, outcome: string, text: string): void {
	try {
		pi.appendEntry("model_guard_compaction", { outcome, text })
	} catch {
		// Diagnostics are best-effort only.
	}
}

/** The inline adapter rejects with INLINE_COMPACT_IN_PROGRESS_MESSAGE when
 *  another compaction owns the session — a defer (a later turn retries), not
 *  a failure. Matched exactly against the adapter's exported constant so a
 *  wording change there cannot silently break this classification. */
function isCompetingCompactionError(message: string): boolean {
	return message === INLINE_COMPACT_IN_PROGRESS_MESSAGE
}

/** Cancellation (user abort / shutdown) — clean up, never suppress or announce. */
function isCancellationError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || /compaction cancelled/i.test(error.message))
}

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
	latestMessages = []
	latestMessagesTimestamp = 0
	imageDescriptions.clear()
	sessionGeneration += 1
	midTurnCompaction.inFlight = false
	midTurnCompaction.awaitingValidation = false
	midTurnCompaction.suppressed = false
	midTurnCompaction.adapterMissingDiagnosed = false
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

	// Cache refresh only: after any compaction (this guard's, /compact, or
	// upstream threshold compaction), refresh the cached context/image state
	// so model-switch guards see post-compaction reality immediately. Attempt
	// ownership lives in the turn_end handler — a session_compact event alone
	// neither proves the next request shrank nor requests a new run. Ordinary
	// compaction does not replace AgentSession in the pinned upstream, so the
	// ctx stays valid across it.
	_pi.on("session_compact", async (_event, ctx: ExtensionContext) => {
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

		const threshold = model.contextWindow - COMPACTION_RESERVE_TOKENS
		const usage = "usage" in msg ? msg.usage : undefined
		const totalTokens = typeof usage?.totalTokens === "number" ? usage.totalTokens : 0

		// Effectiveness validation runs on every successful assistant response
		// with positive usage — before the toolUse-only trigger gate below, so the
		// final-answer turn also validates. Error/aborted responses and zero or
		// missing usage are not shrinkage evidence; retained pre-compaction usage
		// and summary-generation usage are never read here.
		if (totalTokens > 0 && msg.stopReason !== "error" && msg.stopReason !== "aborted") {
			if (midTurnCompaction.awaitingValidation) {
				midTurnCompaction.awaitingValidation = false
				if (totalTokens > threshold) {
					// Insufficient relief is not proof of a resynchronization bug —
					// retained content or a large new response can also explain it.
					// Suppress further mid-turn attempts until a later successful
					// response lands at/below threshold or the session resets.
					midTurnCompaction.suppressed = true
					appendMidTurnDiagnostic(
						_pi,
						"insufficient_relief",
						`Mid-turn compaction insufficient relief: next response still ${totalTokens.toLocaleString()} tokens (threshold ${threshold.toLocaleString()}) — suppressing further mid-turn attempts until a below-threshold response`,
					)
				}
			}
			// A fresh response at/below threshold clears suppression: later growth
			// may trigger another compaction; there is no session cap.
			if (totalTokens <= threshold) {
				midTurnCompaction.suppressed = false
			}
		}

		// Trigger gates — only the in-progress toolUse turn. stop/error/aborted
		// responses are already handled by _handlePostAgentRun.
		if (msg.stopReason !== "toolUse") return
		if (totalTokens <= threshold) return

		// /settings Auto-compact toggle (settings.json compaction.enabled).
		// Project trust is already synced onto the settings reader by
		// settingsTrustSyncExtension at session_start.
		if (!getCompactionEnabled()) return

		if (midTurnCompaction.suppressed) return
		if (midTurnCompaction.inFlight) return

		// Root-cause guard: compaction must not summarise away an assistant
		// toolCall whose toolResult is appended later. Read the current branch —
		// never a cached prior context.
		let activeMessages: ContextEvent["messages"]
		try {
			const branch = await Promise.resolve(ctx.sessionManager.getBranch())
			activeMessages = buildSessionContext(branch).messages
		} catch (err) {
			console.warn("[model-guard] mid-turn compaction branch read failed:", err)
			return
		}
		if (isToolCallInFlight(activeMessages)) return

		// The awaitable inline adapter keeps the compaction inside the awaited
		// turn_end handler, so the SAME run continues on the compacted context —
		// the awaited agent.prompt() chain stays the single owner of the work.
		// The CLI installs the adapter (src/cli.ts → upstream-inline-compact-patch).
		// Hosts without it get one diagnostic and NO aborting fallback: the detached
		// manual path cannot provide run continuation (print mode disposes the
		// runtime before it completes), so upstream run-end compaction remains
		// their safety net.
		const inlineCompact = ctx.inlineCompact
		if (typeof inlineCompact !== "function") {
			if (!midTurnCompaction.adapterMissingDiagnosed) {
				midTurnCompaction.adapterMissingDiagnosed = true
				appendMidTurnDiagnostic(
					_pi,
					"adapter_unavailable",
					"Mid-turn compaction skipped: inline compaction adapter unavailable on this context",
				)
			}
			midTurnCompaction.suppressed = true
			return
		}

		const attemptGeneration = sessionGeneration
		midTurnCompaction.inFlight = true
		try {
			const result = await inlineCompact()
			// A late completion from a replaced session must not notify or
			// mutate the replacement's state.
			if (attemptGeneration !== sessionGeneration) return
			midTurnCompaction.awaitingValidation = true
			ctx.ui?.notify(
				`Context compacted (${result.tokensBefore.toLocaleString()} tokens → summary). Continuing automatically.`,
				"info",
			)
			appendMidTurnDiagnostic(
				_pi,
				"success",
				`Mid-turn compaction complete: ${result.tokensBefore.toLocaleString()} tokens before compaction; continuing automatically`,
			)
		} catch (error) {
			if (attemptGeneration !== sessionGeneration) return
			// Cancellation must end the run: clean up only — never clear the
			// abort state, enqueue work, or announce success.
			if (isCancellationError(error)) return
			const message = error instanceof Error ? error.message : String(error)
			// A competing compaction is a defer, not a failure — a later turn
			// may retry once that operation settles.
			if (isCompetingCompactionError(message)) return
			midTurnCompaction.suppressed = true
			appendMidTurnDiagnostic(
				_pi,
				"failure",
				`Mid-turn compaction failed: ${message} — suppressing further attempts for this pressure episode`,
			)
		} finally {
			// Only clear the in-flight guard for the session that owns the
			// attempt; a replacement session has fresh state.
			if (attemptGeneration === sessionGeneration) {
				midTurnCompaction.inFlight = false
			}
		}
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
