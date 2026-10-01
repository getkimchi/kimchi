import type { AssistantMessage, Message, TextContent } from "@earendil-works/pi-ai"
import type { AgentEndEvent, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getAvailableModels } from "../../../startup-context.js"
import { isAgentWorker } from "../../agent-worker-context.js"
import type { TelemetryContext } from "../session-context.js"
import { handleTransportError } from "./transport-errors.js"

/** Maps OAuth provider IDs to canonical names accepted by the telemetry backend. */
const PROVIDER_TELEMETRY_MAP: Record<string, string> = {
	"openai-codex": "openai",
}

export function handleMessageStart(tm: TelemetryContext, ctx: ExtensionContext, event: { message: Message }): void {
	const msg = event.message
	if (msg.role !== "assistant") return
	const model = msg.model ?? ctx.model?.id
	if (model && model !== "unknown") tm.currentModel = model
	// Always key timing by timestamp — it's set at message creation and never changes.
	// responseId may not exist at message_start yet (assigned by provider mid-stream).
	if (msg.timestamp != null) {
		tm.messageStartTimes.set(String(msg.timestamp), Date.now())
	}
}

export async function handleMessageEnd(
	tm: TelemetryContext,
	ctx: ExtensionContext,
	event: { message: Message },
): Promise<void> {
	const msg = event.message
	if (msg.role !== "assistant") return
	try {
		const assistant = msg
		const msgId = assistant.responseId ? String(assistant.responseId) : String(assistant.timestamp)
		if (tm.sentMessages.has(msgId)) return
		tm.sentMessages.add(msgId)

		const model = assistant.model ?? ctx.model?.id ?? "unknown"
		if (model !== "unknown") tm.currentModel = model
		const availableModels = getAvailableModels()
		const meta = availableModels.find(
			(m: { slug: string; provider?: string; limits?: { context_window?: number } }) => m.slug === model,
		)
		const rawProvider = String(assistant.provider ?? "unknown")
		const resolvedProvider = meta?.provider ? meta.provider : rawProvider === "kimchi-dev" ? "ai-enabler" : rawProvider
		const provider = PROVIDER_TELEMETRY_MAP[resolvedProvider] ?? resolvedProvider
		const input = assistant.usage?.input ?? 0
		const output = assistant.usage?.output ?? 0
		const cacheRead = assistant.usage?.cacheRead ?? 0
		const cacheWrite = assistant.usage?.cacheWrite ?? 0
		const costTotal = assistant.usage?.cost?.total ?? 0
		let startMs: number | undefined
		if (assistant.timestamp != null) {
			startMs = tm.messageStartTimes.get(String(assistant.timestamp))
			tm.messageStartTimes.delete(String(assistant.timestamp))
		}
		const durationMs = Date.now() - (startMs ?? tm.telemetryStartMs)

		tm.emit(
			"api_request",
			{
				provider,
				input_tokens: input,
				output_tokens: output,
				cache_read_tokens: cacheRead,
				cache_creation_tokens: cacheWrite,
				cost_usd: costTotal,
				duration_ms: durationMs,
				...tm.getTraceAttributes(),
			},
			ctx,
		)

		// Detect and emit transport errors (socket closed, connection reset, etc.)
		handleTransportError(tm, ctx, { message: assistant })

		// Accumulate tokens/cost for cumulative metrics
		if (!tm.cumulative.tokensByModel[model]) {
			tm.cumulative.tokensByModel[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
		}
		const tokens = tm.cumulative.tokensByModel[model]
		tokens.input += input
		tokens.output += output
		tokens.cacheRead += cacheRead
		tokens.cacheWrite += cacheWrite
		tm.cumulative.costByModel[model] = (tm.cumulative.costByModel[model] ?? 0) + costTotal
	} catch (err) {
		console.error("[telemetry] message_end handler error:", err)
	}
}

export function handleBeforeAgentStart(tm: TelemetryContext, ctx: ExtensionContext, event: { prompt: string }): void {
	if (tm.currentModel === "unknown") {
		const modelId = ctx.model?.id
		if (modelId) tm.currentModel = modelId
	}
	tm.promptStartMs = Date.now()
	tm.emit(
		"user_message",
		{
			message_length: event.prompt.length,
			turn_index: tm.turnIndex,
		},
		ctx,
	)
}

export function handleAgentEnd(tm: TelemetryContext, ctx: ExtensionContext, event: AgentEndEvent): void {
	const messages = event.messages ?? []

	// User interruption (Esc / abort): pi appends a final assistant message
	// with stopReason "aborted" and fires agent_end. This ends a turn, not a
	// session — session.end{ended_by} never observes it, which is why this
	// event exists.
	const interruption = detectInterruption(messages)
	if (interruption) {
		// Under backend routing the assistant message keeps the virtual id in
		// `model`; the concrete pick lands in `responseModel`. Report it as a
		// separate attribute so interruptions stay sliceable by the routed
		// backend without a server-side join.
		const routedModel = messages.findLast(
			(m): m is AssistantMessage =>
				m.role === "assistant" && typeof m.responseModel === "string" && m.responseModel !== m.model,
		)?.responseModel
		tm.emit(
			"agent.interrupted",
			{
				phase: interruption.phase,
				...(interruption.toolName ? { tool_name: interruption.toolName } : {}),
				// Subagent runs get their own telemetry instance, so one Esc that
				// aborts a subagent AND the main run can produce two records;
				// downstream dashboards deduplicate on this flag (loop_guard
				// convention) together with session.parent_id.
				is_subagent: String(isAgentWorker()),
				turn_index: tm.turnIndex,
				ms_into_turn: tm.promptStartMs > 0 ? Date.now() - tm.promptStartMs : 0,
			},
			ctx,
			// `currentModel` is the user-facing selection: under backend routing
			// the assistant message keeps the virtual id (`auto`) in
			// `message.model`, so "quit rate with Auto selected" stays
			// answerable; `routed_model` carries the concrete pick.
			{ model: tm.currentModel, ...(routedModel ? { routed_model: routedModel } : {}) },
		)
		return
	}

	if (!messages.length) return
	const last = messages[messages.length - 1]
	if (last.role !== "toolResult" || !last.isError) return

	const text = Array.isArray(last.content)
		? ((last.content[0] as TextContent | undefined)?.text ?? "unknown error")
		: "unknown error"
	tm.emit(
		"error",
		{
			error_type: "agent_error",
			error_message: text.slice(0, 300),
			turn_index: tm.turnIndex,
			...tm.getTraceAttributes(),
		},
		ctx,
	)
}

/**
 * Classify the activity the user interrupted, from the agent run's new
 * messages. Pi's abort semantics (pi-agent-core agent-loop):
 *
 * - Abort mid-LLM-stream: the assistant response comes back with
 *   stopReason "aborted" carrying whatever streamed before the cancel.
 * - Abort while a tool executes: the tool's (aborted) result lands first,
 *   and the follow-up assistant response — started with an already-aborted
 *   signal — comes back "aborted" with empty content (pi's own renderer
 *   special-cases "aborted messages with no content" for this reason).
 *
 * Attribute: aborted-with-content → "llm" (streaming when cancelled); empty
 * abort preceded by an errored tool result → "tool" (that tool was running);
 * anything else → "llm". Not bulletproof (an Esc pressed before the first
 * streamed token also yields an empty abort), but "llm" is the right
 * fallback since no tool was executing in that window.
 */
function detectInterruption(
	messages: AgentEndEvent["messages"],
): { phase: "llm" | "tool"; toolName?: string } | undefined {
	let abortedIdx = -1
	let abortedMsg: AssistantMessage | undefined
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg.role === "assistant") {
			abortedMsg = msg
			if (msg.stopReason === "aborted") abortedIdx = i
			break
		}
	}
	if (abortedIdx < 0 || !abortedMsg) return undefined

	const content = Array.isArray(abortedMsg.content) ? abortedMsg.content : []
	if (content.length > 0) return { phase: "llm" }

	// Empty aborted response: walk the contiguous toolResult block directly
	// preceding it — an errored result marks the tool that was killed. Report
	// the errored result's own name: with parallel tool calls the block mixes
	// results, and the most recent name may belong to a sibling call.
	let toolName: string | undefined
	for (let i = abortedIdx - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg.role !== "toolResult") break
		const result = msg as { toolName?: string; isError?: boolean }
		toolName = toolName ?? result.toolName
		if (result.isError) return { phase: "tool", toolName: result.toolName ?? toolName }
	}
	return { phase: "llm" }
}
