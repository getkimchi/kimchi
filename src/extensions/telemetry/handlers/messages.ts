import type { AssistantMessage } from "@earendil-works/pi-ai"
import { getAvailableModels } from "../../../startup-context.js"
import type { SessionContext } from "../session-context.js"

/** Maps OAuth provider IDs to canonical names accepted by the telemetry backend. */
const PROVIDER_TELEMETRY_MAP: Record<string, string> = {
	"openai-codex": "openai",
}

export function handleMessageStart(
	ctx: SessionContext,
	event: { message: { role: string; timestamp?: number; model?: string } },
): void {
	const msg = event.message
	if (msg.role !== "assistant") return
	if (msg.model && msg.model !== "unknown") ctx.currentModel = msg.model
	// Always key timing by timestamp — it's set at message creation and never changes.
	// responseId may not exist at message_start yet (assigned by provider mid-stream).
	if (msg.timestamp != null) {
		ctx.messageStartTimes.set(String(msg.timestamp), Date.now())
	}
}

export async function handleMessageEnd(
	ctx: SessionContext,
	event: { message: Record<string, unknown> },
): Promise<void> {
	const msg = event.message
	if (msg.role !== "assistant") return
	try {
		const assistant = msg as unknown as AssistantMessage
		const msgId = assistant.responseId ? String(assistant.responseId) : String(assistant.timestamp)
		if (ctx.sentMessages.has(msgId)) return
		ctx.sentMessages.add(msgId)

		const model = assistant.model ?? "unknown"
		if (model !== "unknown") ctx.currentModel = model
		const availableModels = getAvailableModels()
		const meta = availableModels.find((m: { slug: string; provider?: string }) => m.slug === model)
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
			startMs = ctx.messageStartTimes.get(String(assistant.timestamp))
			ctx.messageStartTimes.delete(String(assistant.timestamp))
		}
		const durationMs = Date.now() - (startMs ?? ctx.sessionStartMs)

		ctx.emit("api_request", {
			model,
			provider,
			input_tokens: input,
			output_tokens: output,
			cache_read_tokens: cacheRead,
			cache_creation_tokens: cacheWrite,
			cost_usd: costTotal,
			duration_ms: durationMs,
		})

		// Accumulate tokens/cost for cumulative metrics
		if (!ctx.cumulative.tokensByModel[model]) {
			ctx.cumulative.tokensByModel[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
		}
		const tokens = ctx.cumulative.tokensByModel[model]
		tokens.input += input
		tokens.output += output
		tokens.cacheRead += cacheRead
		tokens.cacheWrite += cacheWrite
		ctx.cumulative.costByModel[model] = (ctx.cumulative.costByModel[model] ?? 0) + costTotal
	} catch (err) {
		console.error("[telemetry] message_end handler error:", err)
	}
}

export function handleBeforeAgentStart(ctx: SessionContext, event: { prompt: string }): void {
	ctx.emit("user_message", { model: ctx.currentModel, message_length: event.prompt.length })
}

export function handleAgentEnd(
	ctx: SessionContext,
	event: { messages?: { role?: string; content?: unknown[]; isError?: boolean }[] },
): void {
	const messages = event.messages
	if (!messages?.length) return
	const last = messages[messages.length - 1]
	if (last.role === "toolResult" && last.isError) {
		const text = Array.isArray(last.content)
			? ((last.content[0] as { text?: string } | undefined)?.text ?? "unknown error")
			: "unknown error"
		ctx.emit("error", { model: ctx.currentModel, error_type: "agent_error", error_message: text.slice(0, 300) })
	}
}
