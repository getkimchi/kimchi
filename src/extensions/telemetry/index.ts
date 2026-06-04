import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { TelemetryConfig } from "../../config.js"

import { handleAgentEnd, handleBeforeAgentStart, handleMessageEnd, handleMessageStart } from "./handlers/messages.js"
import { emitSessionStartEvent, handleSessionInitialized, handleSessionShutdown } from "./handlers/session.js"
import { handleToolExecutionEnd, handleToolExecutionStart } from "./handlers/tools.js"
import { SessionContext } from "./session-context.js"
import {
	type SurveyAnsweredTelemetry,
	type SurveyDismissedTelemetry,
	type SurveyShownTelemetry,
	emitSurveyAnswered,
	emitSurveyDismissed,
	emitSurveyShown,
} from "./survey.js"

let _ctx: SessionContext | undefined
let _telemetryConfig: TelemetryConfig = { enabled: false, endpoint: "", metricsEndpoint: "", headers: {}, apiKey: "" }
let sessionStartEmitted = false

export { _telemetryConfig }

export async function trackSubagentSpawned(args: { id: string; type: string; description: string }): Promise<void> {
	if (!_ctx || !_telemetryConfig.enabled || !_telemetryConfig.endpoint) return
	_ctx.emit("subagent.spawned", { model: _ctx.currentModel, agent_type: args.type, reason: args.description })
}

export function trackSurveyShown(args: SurveyShownTelemetry): void {
	if (!_ctx || !_telemetryConfig.enabled || !_telemetryConfig.endpoint) return
	emitSurveyShown(_ctx, args)
}

export function trackSurveyAnswered(args: SurveyAnsweredTelemetry): void {
	if (!_ctx || !_telemetryConfig.enabled || !_telemetryConfig.endpoint) return
	emitSurveyAnswered(_ctx, args)
}

export function trackSurveyDismissed(args: SurveyDismissedTelemetry): void {
	if (!_ctx || !_telemetryConfig.enabled || !_telemetryConfig.endpoint) return
	emitSurveyDismissed(_ctx, args)
}

export default function telemetryExtension(config: TelemetryConfig) {
	_telemetryConfig = config
	return (pi: ExtensionAPI) => {
		if (!config.enabled) return

		const ctx = new SessionContext(config, "cli")
		_ctx = ctx

		pi.on("session_start", async (_event, extCtx) => {
			const modelId = (extCtx as { model?: { id?: string } } | undefined)?.model?.id
			handleSessionInitialized(ctx, modelId)
		})
		pi.on("session_shutdown", async (event) => handleSessionShutdown(ctx, event as { reason?: string }))
		pi.on("message_start", async (event) =>
			handleMessageStart(ctx, event as { message: { role: string; responseId?: string; timestamp?: number } }),
		)
		pi.on("message_end", async (event) =>
			handleMessageEnd(ctx, event as unknown as { message: Record<string, unknown> }),
		)
		pi.on("model_select", async (event) => {
			const e = event as { model?: { id?: string } }
			ctx.currentModel = e.model?.id ?? "unknown"
		})
		pi.on("tool_execution_start", async (event) =>
			handleToolExecutionStart(ctx, event as { toolCallId: string; toolName: string; args: unknown }),
		)
		pi.on("tool_execution_end", async (event) => {
			handleToolExecutionEnd(ctx, event as { toolCallId: string; isError?: boolean; result?: unknown })
		})
		pi.on("before_agent_start", async (event, extCtx) => {
			if (!sessionStartEmitted) {
				sessionStartEmitted = true
				emitSessionStartEvent(ctx)
			}
			if (ctx.currentModel === "unknown") {
				const modelId = (extCtx as { model?: { id?: string } } | undefined)?.model?.id
				if (modelId) ctx.currentModel = modelId
			}
			const e = event as { prompt: string }
			handleBeforeAgentStart(ctx, e)
		})
		pi.on("agent_end", async (event) => {
			handleAgentEnd(ctx, event as { messages?: { role?: string; content?: unknown[] }[] })
		})
	}
}
