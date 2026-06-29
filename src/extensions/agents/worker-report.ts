import { type ExtensionAPI, defineTool } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { AgentReport } from "./personas/types.js"
import { textResult } from "./tool-result.js"

export const WORKER_REPORT_TOOL_NAME = "submit_agent_report"

export type WorkerReportSubmission = Omit<AgentReport, "submitted_at" | "attempt_id">

export interface WorkerReportCapability {
	submit(report: WorkerReportSubmission): { accepted: boolean; message: string }
	isAccepted(): boolean
}

/**
 * Creates the report tool for one linked worker session.
 *
 * The capability is bound to the owning Agent record by the parent manager, so
 * worker-controlled IDs or bearer tokens are neither accepted nor required.
 */
export function createWorkerReportExtension(
	capability: WorkerReportCapability,
	onAccepted?: () => void,
): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.registerTool(
			defineTool({
				name: WORKER_REPORT_TOOL_NAME,
				label: "Submit Agent Report",
				description:
					"Submit the final structured progress report for this Ferment-linked worker. Call this alone as the final action after completing edits and verification.",
				parameters: Type.Object({
					status: Type.Union([Type.Literal("completed"), Type.Literal("partial"), Type.Literal("blocked")]),
					summary: Type.String(),
					steps_completed: Type.Array(Type.String()),
					remaining_steps: Type.Array(Type.String()),
					files_touched: Type.Optional(Type.Array(Type.String())),
					verification: Type.Optional(Type.Array(Type.String())),
					blockers: Type.Optional(Type.Array(Type.String())),
					notes: Type.Optional(Type.String()),
				}),
				execute: async (_toolCallId, params) => {
					const status = params.status as AgentReport["status"]
					const remainingSteps = params.remaining_steps as string[]
					if (status === "completed" && remainingSteps.length > 0) {
						return textResult('A completed report must use remaining_steps: []. Use status "partial" if work remains.')
					}
					if (status === "partial" && remainingSteps.length === 0) {
						return textResult("A partial report must identify at least one remaining step.")
					}
					const blockers = params.blockers as string[] | undefined
					if (status === "blocked" && (!blockers || blockers.length === 0)) {
						return textResult("A blocked report must identify at least one blocker.")
					}

					const result = capability.submit({
						status,
						summary: params.summary as string,
						steps_completed: params.steps_completed as string[],
						remaining_steps: remainingSteps,
						files_touched: params.files_touched as string[] | undefined,
						verification: params.verification as string[] | undefined,
						blockers,
						notes: params.notes as string | undefined,
					})
					if (result.accepted) onAccepted?.()
					return textResult(result.message)
				},
			}),
		)
	}
}
