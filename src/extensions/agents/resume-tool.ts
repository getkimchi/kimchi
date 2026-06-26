import { type ExtensionAPI, defineTool } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { AgentManager } from "./manager/agent-manager.js"
import { textResult } from "./tool-result.js"

export function registerResumeSubagentTool(pi: ExtensionAPI, manager: AgentManager): void {
	pi.registerTool(
		defineTool({
			name: "resume_subagent",
			label: "Resume Agent",
			description:
				"Continue an existing Agent session with a bounded steering prompt, or request host-bounded report finalization. Persona, model, description, and task linkage are inherited from the original Agent.",
			parameters: Type.Object({
				agent_id: Type.String({ description: "Agent ID returned by the original Agent call." }),
				prompt: Type.Optional(
					Type.String({ description: "Required for continuation; ignored for host-controlled report finalization." }),
				),
				max_turns: Type.Optional(
					Type.Integer({ description: "Required fresh turn allowance for continuation.", minimum: 1 }),
				),
				max_duration: Type.Optional(
					Type.Integer({ description: "Required wall-clock limit in seconds for continuation.", minimum: 1 }),
				),
				token_budget: Type.Optional(
					Type.Integer({ description: "Maximum output tokens for this attempt.", minimum: 1024 }),
				),
				purpose: Type.Optional(
					Type.Union([Type.Literal("continuation"), Type.Literal("continue"), Type.Literal("finalize_report")], {
						description:
							'Use "continuation" for follow-up work ("continue" is accepted as a compatibility alias). Use finalize_report only when task work is already finished and the worker only needs to submit its report.',
					}),
				),
			}),
			execute: async (_toolCallId, params, signal) => {
				const agentId = params.agent_id as string
				const rawPurpose = params.purpose as "continuation" | "continue" | "finalize_report" | undefined
				const purpose = rawPurpose === "continue" ? "continuation" : (rawPurpose ?? "continuation")
				const existing = manager.getRecord(agentId)
				if (!existing) return textResult(`Agent not found: "${agentId}". It may have been cleaned up.`)
				if (!existing.session) return textResult(`Agent "${agentId}" has no active session to resume.`)
				if (existing.status === "running" || existing.status === "queued") {
					return textResult(`Agent "${agentId}" is still ${existing.status}; steer it or wait for completion instead.`)
				}
				const blocked = manager.getResumeBlockReason(agentId, purpose)
				if (blocked) return textResult(blocked)
				if (purpose === "continuation") {
					if (!(params.prompt as string | undefined)?.trim()) {
						return textResult("Continuation requires a non-empty prompt based on the worker's latest outcome.")
					}
					if (params.max_turns == null || params.max_duration == null) {
						return textResult("Continuation requires explicit max_turns and max_duration limits.")
					}
				}

				const record = await manager.resume(
					agentId,
					purpose === "finalize_report" ? undefined : (params.prompt as string),
					purpose === "finalize_report"
						? { signal, purpose }
						: {
								signal,
								maxTurns: params.max_turns as number,
								tokenBudget: params.token_budget as number | undefined,
								maxDuration: params.max_duration as number,
								purpose,
							},
				)
				if (!record) return textResult(`Failed to resume agent "${agentId}".`)
				const outcome = record.latestOutcome
					? `\n\nagent_outcome:\n${JSON.stringify(record.latestOutcome, null, 2)}`
					: ""
				return {
					content: [
						{
							type: "text" as const,
							text: `${record.result?.trim() || record.error?.trim() || "No output."}${outcome}`,
						},
					],
					details: {
						agentId: record.id,
						status: record.status,
						abortReason: record.abortReason,
						error: record.error,
						agentOutcome: record.latestOutcome,
					},
				}
			},
		}),
	)
}
