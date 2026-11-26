import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai"
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	SessionManager,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent"
import { isAcpSessionHost } from "../modes/acp/state.js"
import { CANONICAL_THINKING_LEVELS } from "../thinking-levels.js"
import { thinkingSelection } from "../thinking-selection.js"
import { notifyUser } from "../utils/notify-user.js"
import { isAutoRoutedModel } from "./auto-model/constants.js"
import { getEffectiveModel } from "./auto-model/state.js"

interface LengthFallbackState {
	editId: string
	originalThinking: ModelThinkingLevel
	originalModel: string | undefined
	fallbackThinking: ModelThinkingLevel
	/** Becomes true only after the native enqueue operation returns. */
	queued: boolean
	cancelled: boolean
	userOverrodePreference: boolean
	expectedSelection?: { previous: ModelThinkingLevel; next: ModelThinkingLevel }
}

/** Administrative identity: an ACP reattachment has a different manager object even for the same session id. */
const recoveryByOwner = new WeakMap<ExtensionContext["sessionManager"], LengthFallbackState>()
const cancellationByOwner = new WeakMap<ExtensionContext["sessionManager"], number>()
const deliveredContinuations = new WeakMap<ExtensionContext["sessionManager"], string>()
/** Spread copies preserve the symbol; JSON serialization does not expose it. */
const LENGTH_FAILURE = Symbol.for("kimchi.lengthRecovery.contextEdit")
const LENGTH_CONTINUATION = "request-length-continuation"
const DOWNGRADE_LEVELS = new Set<ModelThinkingLevel>(["high", "xhigh", "max"])

function modelKey(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined
}

function hasText(message: AssistantMessage): boolean {
	return message.content.some((part) => part.type === "text" && part.text.trim().length > 0)
}

function hasToolCalls(message: AssistantMessage): boolean {
	return message.content.some((part) => part.type === "toolCall")
}

function markForOmission(message: AssistantMessage, editId: string): void {
	Object.defineProperty(message, LENGTH_FAILURE, { value: editId, enumerable: true, configurable: true })
}

function hasFailureMarker(message: ContextEvent["messages"][number]): boolean {
	return typeof (message as unknown as Record<symbol, unknown>)[LENGTH_FAILURE] === "string"
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`
	try {
		return JSON.stringify(error)
	} catch {
		return String(error)
	}
}

export interface ResponseRecoveryExtensionOptions {
	headlessNotices?: "console" | "suppress"
}

type RecoveryNotifier = (ctx: ExtensionContext, message: string, severity: "info" | "warning") => void

function warn(ctx: ExtensionContext, message: string, notify: RecoveryNotifier): void {
	notify(ctx, message, "warning")
}

function setRecoveryThinking(
	pi: ExtensionAPI,
	_ctx: ExtensionContext,
	state: LengthFallbackState,
	next: ModelThinkingLevel,
): void {
	const previous = pi.getThinkingLevel()
	state.expectedSelection = previous === next ? undefined : { previous, next }
	pi.setThinkingLevel(next)
	if (pi.getThinkingLevel() !== next) throw new Error(`The ${next} thinking level was not applied`)
}

function restore(pi: ExtensionAPI, ctx: ExtensionContext, state: LengthFallbackState): void {
	if (recoveryByOwner.get(ctx.sessionManager) !== state) return
	recoveryByOwner.delete(ctx.sessionManager)
	deliveredContinuations.delete(ctx.sessionManager)
	// Selection events are authoritative, including deliberate changes ending at the fallback level.
	if (state.userOverrodePreference || modelKey(ctx) !== state.originalModel) return
	if (pi.getThinkingLevel() !== state.fallbackThinking) return
	try {
		setRecoveryThinking(pi, ctx, state, state.originalThinking)
	} catch (error) {
		console.error("response-recovery: could not restore original effort:", errorMessage(error))
	}
}

function finish(pi: ExtensionAPI, ctx: ExtensionContext, successful: boolean): void {
	const state = recoveryByOwner.get(ctx.sessionManager)
	if (!state) return
	if (successful) {
		recoveryByOwner.delete(ctx.sessionManager)
		deliveredContinuations.delete(ctx.sessionManager)
	} else restore(pi, ctx, state)
}

function cancelPending(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const owner = ctx.sessionManager
	const state = recoveryByOwner.get(owner)
	if (state) {
		state.cancelled = true
		restore(pi, ctx, state)
	}
	deliveredContinuations.delete(owner)
	cancellationByOwner.set(owner, (cancellationByOwner.get(owner) ?? 0) + 1)
}

function persistTruncatedProjection(ctx: ExtensionContext, message: AssistantMessage, entryId: string): string {
	// The extension type is read-only, but ctx exposes the actual native SessionManager.
	// Its public context-edit contract is also used by buildSessionProjection after replay.
	const manager = ctx.sessionManager as unknown as SessionManager
	const replacement = hasText(message) ? { content: message.content.filter((part) => part.type === "text") } : null
	const editId = manager.appendContextEdit(entryId, replacement)
	if (manager.getEntry(editId)?.type !== "context_edit") throw new Error("Native context edit is missing")
	return editId
}

function enqueueRecovery(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: LengthFallbackState,
	generation: number,
	partial: boolean,
	notify: RecoveryNotifier,
): void {
	try {
		setRecoveryThinking(pi, ctx, state, state.fallbackThinking)
		pi.sendMessage(
			{
				customType: LENGTH_CONTINUATION,
				content: partial
					? "Your previous answer reached the output length limit. Continue from its last visible character without restarting or repeating it. Complete the user's own previous request."
					: "Your previous answer reached the output length limit before producing visible text. Answer the user's own previous request now.",
				display: false,
			},
			{ deliverAs: "followUp" },
		)
		if (
			state.cancelled ||
			recoveryByOwner.get(ctx.sessionManager) !== state ||
			cancellationByOwner.get(ctx.sessionManager) !== generation
		)
			return
		// agent.followUp synchronously admits the custom message to the native queue.
		state.queued = true
		notify(ctx, `Response reached the output limit. Queued one ${state.fallbackThinking} continuation.`, "info")
	} catch (error) {
		console.error("response-recovery: could not enqueue lower-effort continuation:", errorMessage(error))
		restore(pi, ctx, state)
		warn(ctx, "Could not retry the truncated response. Your original effort is restored; ask me to continue.", notify)
	}
}

function handleLength(
	pi: ExtensionAPI,
	event: TurnEndEvent,
	ctx: ExtensionContext,
	notify: RecoveryNotifier,
): { continue: boolean } | undefined {
	if (event.message.role !== "assistant") return
	if (isAcpSessionHost()) return
	const message = event.message
	const owner = ctx.sessionManager
	if (recoveryByOwner.has(owner)) {
		warn(ctx, "Response reached the output limit again. Your original effort is restored; ask me to continue.", notify)
		return { continue: false }
	}
	if (event.toolResults.some((result) => result.isError) || hasToolCalls(message)) {
		warn(
			ctx,
			"Response reached the output limit. Ask me to continue; tool-bearing output does not get a custom replay.",
			notify,
		)
		return
	}
	const actual = isAutoRoutedModel({ provider: message.provider, id: message.model })
		? message.thinkingLevel
		: (message.thinkingLevel ?? ctx.thinkingLevel)
	if (!actual || !DOWNGRADE_LEVELS.has(actual)) {
		warn(
			ctx,
			"Response reached the output limit, but the actual effort is unknown or too low for a downward retry. Nothing was queued.",
			notify,
		)
		return
	}
	const selection = thinkingSelection(getEffectiveModel(ctx))
	if (selection.mode !== "levels" || selection.selectable.length === 0) {
		warn(
			ctx,
			"Response reached the output limit, but this model has no supported downgrade. Nothing was queued.",
			notify,
		)
		return
	}
	const rank = CANONICAL_THINKING_LEVELS.indexOf(actual)
	const lower = CANONICAL_THINKING_LEVELS.findLast(
		(level) => selection.selectable.includes(level) && CANONICAL_THINKING_LEVELS.indexOf(level) < rank,
	)
	if (!lower) {
		warn(
			ctx,
			`Response reached the output limit, but ${actual} has no supported lower level. Nothing was queued.`,
			notify,
		)
		return
	}
	let originalThinking: ModelThinkingLevel
	try {
		originalThinking = pi.getThinkingLevel()
	} catch (error) {
		console.error("response-recovery: could not read the original effort:", errorMessage(error))
		warn(ctx, "Could not read the session's effort. Nothing was queued or omitted.", notify)
		return
	}
	if (!CANONICAL_THINKING_LEVELS.includes(originalThinking)) {
		warn(
			ctx,
			"Response reached the output limit, but the session preference is unknown. Nothing was queued or omitted.",
			notify,
		)
		return
	}
	let editId: string
	try {
		// Persist before setup or enqueue. Raw history is retained; only provider projection changes.
		editId = persistTruncatedProjection(ctx, message, event.messageEntryId)
	} catch (error) {
		console.error("response-recovery: could not persist truncated-assistant omission:", errorMessage(error))
		warn(ctx, "Could not prepare a lower-effort retry. Ask me to continue; nothing was queued.", notify)
		return
	}
	const state: LengthFallbackState = {
		editId,
		originalThinking,
		originalModel: modelKey(ctx),
		fallbackThinking: lower,
		queued: false,
		cancelled: false,
		userOverrodePreference: false,
	}
	if (!hasText(message)) markForOmission(message, editId)
	deliveredContinuations.delete(owner)
	recoveryByOwner.set(owner, state)
	const generation = (cancellationByOwner.get(owner) ?? 0) + 1
	cancellationByOwner.set(owner, generation)
	enqueueRecovery(pi, ctx, state, generation, hasText(message), notify)
	return { continue: false }
}

export function createResponseRecoveryExtension(options: ResponseRecoveryExtensionOptions = {}): ExtensionFactory {
	const notify: RecoveryNotifier =
		options.headlessNotices === "suppress"
			? (ctx, message, severity) => {
					if (ctx.hasUI) ctx.ui.notify(message, severity)
				}
			: notifyUser
	return (pi) => {
		pi.on("input", (_event, ctx) => {
			if (!recoveryByOwner.has(ctx.sessionManager)) return
			cancelPending(pi, ctx)
			ctx.abort()
		})
		pi.on("turn_end", (event, ctx) => {
			if (event.message.role === "assistant" && event.message.stopReason === "length") {
				return handleLength(pi, event, ctx, notify)
			}
		})
		pi.on("thinking_level_select", (event, ctx) => {
			const state = recoveryByOwner.get(ctx.sessionManager)
			if (!state) return
			const expected = state.expectedSelection
			if (expected && event.previousLevel === expected.previous && event.level === expected.next) {
				state.expectedSelection = undefined
				return
			}
			state.userOverrodePreference = true
		})
		pi.on("model_select", (_event, ctx) => {
			const state = recoveryByOwner.get(ctx.sessionManager)
			if (state) state.userOverrodePreference = true
		})
		pi.on("before_provider_headers", (_event, ctx) => {
			const state = recoveryByOwner.get(ctx.sessionManager)
			if (state?.queued) deliveredContinuations.set(ctx.sessionManager, state.editId)
		})
		pi.on("context", (event, ctx) => ({
			messages: event.messages.filter((message) => {
				if ((message as { customType?: string }).customType === LENGTH_CONTINUATION) {
					const state = recoveryByOwner.get(ctx.sessionManager)
					return state !== undefined && deliveredContinuations.get(ctx.sessionManager) !== state.editId
				}
				return !hasFailureMarker(message)
			}),
		}))
		// cli.ts installs the native retry-decision forwarding wrapper for this channel.
		pi.on("agent_end", (event, ctx) => {
			if (!recoveryByOwner.has(ctx.sessionManager) || (event as unknown as { willRetry?: boolean }).willRetry) return
			const last = event.messages.findLast((message): message is AssistantMessage => message.role === "assistant")
			const succeeded = ctx.signal?.aborted !== true && (last?.stopReason === "stop" || last?.stopReason === "toolUse")
			finish(pi, ctx, succeeded)
		})
		pi.on("agent_settled", ({ aborted }, ctx) => {
			if (aborted) finish(pi, ctx, false)
		})
		pi.on("session_before_switch", (_event, ctx) => cancelPending(pi, ctx))
		pi.on("session_before_compact", (_event, ctx) => cancelPending(pi, ctx))
		pi.on("session_before_fork", (_event, ctx) => cancelPending(pi, ctx))
		pi.on("session_before_tree", (_event, ctx) => cancelPending(pi, ctx))
		pi.on("session_shutdown", (_event, ctx) => cancelPending(pi, ctx))
	}
}

export const responseRecoveryExtension: ExtensionFactory = createResponseRecoveryExtension()
