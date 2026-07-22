import type { Message, TextContent } from "@earendil-works/pi-ai"
import type { AgentEndEvent, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getAvailableModels } from "../../../startup-context.js"
import type { TelemetryContext } from "../session-context.js"
import { handleTransportError } from "./transport-errors.js"

/** Maps OAuth provider IDs to canonical names accepted by the telemetry backend. */
const PROVIDER_TELEMETRY_MAP: Record<string, string> = {
	"openai-codex": "openai",
}

export function handleMessageStart(
	telemetry: TelemetryContext,
	ctx: ExtensionContext,
	event: { message: Message },
): void {
	const msg = event.message
	if (msg.role !== "assistant") return
	const model = msg.model ?? ctx.model?.id
	if (model && model !== "unknown") telemetry.currentModel = model
	// Always key timing by timestamp — it's set at message creation and never changes.
	// responseId may not exist at message_start yet (assigned by provider mid-stream).
	if (msg.timestamp != null) {
		telemetry.messageStartTimes.set(String(msg.timestamp), Date.now())
	}
}

export async function handleMessageEnd(
	telemetry: TelemetryContext,
	ctx: ExtensionContext,
	event: { message: Message },
): Promise<void> {
	const msg = event.message
	if (msg.role !== "assistant") return
	try {
		const assistant = msg
		const msgId = assistant.responseId ? String(assistant.responseId) : String(assistant.timestamp)
		if (telemetry.sentMessages.has(msgId)) return
		telemetry.sentMessages.add(msgId)

		const model = assistant.model ?? ctx.model?.id ?? "unknown"
		if (model !== "unknown") telemetry.currentModel = model
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
			startMs = telemetry.messageStartTimes.get(String(assistant.timestamp))
			telemetry.messageStartTimes.delete(String(assistant.timestamp))
		}
		const durationMs = Date.now() - (startMs ?? telemetry.processStartMs)

		telemetry.emit(
			"api_request",
			{
				provider,
				input_tokens: input,
				output_tokens: output,
				cache_read_tokens: cacheRead,
				cache_creation_tokens: cacheWrite,
				cost_usd: costTotal,
				duration_ms: durationMs,
			},
			ctx,
		)

		// Detect and emit transport errors (socket closed, connection reset, etc.)
		handleTransportError(telemetry, ctx, { message: assistant })

		// Accumulate tokens/cost for cumulative metrics
		if (!telemetry.cumulative.tokensByModel[model]) {
			telemetry.cumulative.tokensByModel[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
		}
		const tokens = telemetry.cumulative.tokensByModel[model]
		tokens.input += input
		tokens.output += output
		tokens.cacheRead += cacheRead
		tokens.cacheWrite += cacheWrite
		telemetry.cumulative.costByModel[model] = (telemetry.cumulative.costByModel[model] ?? 0) + costTotal
	} catch (err) {
		console.error("[telemetry] message_end handler error:", err)
	}
}

export function handleBeforeAgentStart(
	telemetry: TelemetryContext,
	ctx: ExtensionContext,
	event: { prompt: string },
): void {
	telemetry.emit(
		"user_message",
		{
			message_length: event.prompt.length,
			turn_index: telemetry.turnIndex,
		},
		ctx,
	)
}

export function handleAgentEnd(telemetry: TelemetryContext, ctx: ExtensionContext, event: AgentEndEvent): void {
	const messages = event.messages
	if (!messages?.length) return
	const last = messages[messages.length - 1]
	if (last.role !== "toolResult" || !last.isError) return

	const text = Array.isArray(last.content)
		? ((last.content[0] as TextContent | undefined)?.text ?? "unknown error")
		: "unknown error"
	telemetry.emit(
		"error",
		{
			error_type: "agent_error",
			error_message: text.slice(0, 300),
			turn_index: telemetry.turnIndex,
		},
		ctx,
	)
}
