import { defineTool, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { isAgentWorker } from "../agent-worker-context.js"
import { applyWriteTodos, getTodosForScope, resolveTodoScope } from "../todos/store.js"
import type { AgentManager } from "./manager/agent-manager.js"

export const RECONCILE_AGENT_RESULT_TOOL_NAME = "reconcile_agent_result"

/** A parent check must follow the worker's latest completion, on the current branch. */
function findVerification(entries: readonly SessionEntry[], completedAt: number, toolCallId?: string) {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue
		const result = entry.message
		if (toolCallId && result.toolCallId !== toolCallId) continue
		if (result.toolName !== "bash" && result.toolName !== "read") continue
		// Do not silently fall back to an older passing check after a failed check.
		if (result.isError || result.timestamp < completedAt) return undefined
		const call = entries
			.slice(0, i)
			.some(
				(candidate) =>
					candidate.type === "message" &&
					candidate.message.role === "assistant" &&
					candidate.message.timestamp >= completedAt &&
					candidate.message.content.some(
						(block) => block.type === "toolCall" && block.id === result.toolCallId && block.name === result.toolName,
					),
			)
		if (!call) return undefined
		return result
	}
	if (toolCallId) {
		throw new Error(
			"No parent bash/read result matches verification_tool_call_id on the current branch. Omit this field to use the latest parent bash/read result, or supply the exact ID of the relevant check.",
		)
	}
	return undefined
}

export function registerReconcileAgentResultTool(pi: ExtensionAPI, manager: Pick<AgentManager, "getRecord">): void {
	pi.registerTool(
		defineTool({
			name: RECONCILE_AGENT_RESULT_TOOL_NAME,
			label: "Reconcile Agent Result",
			description:
				"After inspecting a completed communicating subagent's result and verifying its work in this parent session, " +
				"complete an existing TODO with the check's provenance. Run a relevant bash check or read the resulting artifact " +
				"after the worker finishes. The host checks provenance; you must judge whether the check covers the task. " +
				"Worker reports and board notes alone are not verification. Ferment is optional.",
			parameters: Type.Object({
				agent_id: Type.String(),
				todo_id: Type.Integer({ minimum: 1 }),
				note: Type.String({
					minLength: 1,
					maxLength: 1200,
					description: "What you checked and what the result establishes.",
				}),
				verification_tool_call_id: Type.Optional(
					Type.String({ description: "Parent bash/read result ID. Omit to use the latest parent bash/read result." }),
				),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				const sessionId = ctx.sessionManager.getSessionId()
				const record = manager.getRecord(params.agent_id)
				if (
					isAgentWorker() ||
					!record?.communication ||
					record.visibility !== "user" ||
					record.communicationScope?.rootSessionId !== sessionId
				) {
					throw new Error("Only the owning parent can reconcile a communicating subagent from this session.")
				}
				// "steered" finished after a soft-limit warning; it is a successful runtime outcome.
				if ((record.status !== "completed" && record.status !== "steered") || record.completedAt === undefined) {
					throw new Error(
						"The subagent has not completed successfully. Wait, resume it, or record the remaining work as blocked.",
					)
				}
				if (
					record.agentReport &&
					(record.agentReport.status !== "completed" || record.agentReport.remaining_steps.length)
				) {
					throw new Error("The subagent report still contains unfinished work. Resolve it before completing the TODO.")
				}
				const scope = resolveTodoScope()
				if (scope.kind === "ferment")
					throw new Error("Phase TODOs are managed by Ferment; reconcile a task TODO instead.")
				const todos = getTodosForScope(scope, sessionId)
				if (!todos.some((todo) => todo.id === params.todo_id))
					throw new Error("The TODO does not exist in the current task list.")
				const note = params.note.trim()
				if (!note) throw new Error("Describe the check and its outcome.")
				const verification = findVerification(
					ctx.sessionManager.getBranch(),
					record.completedAt,
					params.verification_tool_call_id,
				)
				if (!verification) {
					throw new Error(
						"Run a successful parent bash check or read the resulting artifact after this worker finishes. Reports and board posts do not qualify.",
					)
				}
				const evidence = `Evidence: ${note} [agent ${record.id}, attempt ${record.currentAttemptId}; parent ${verification.toolName} ${verification.toolCallId}]`
				const details = applyWriteTodos(
					{
						scope,
						todos: todos.map((todo) =>
							todo.id === params.todo_id ? { ...todo, status: "completed", note: evidence } : todo,
						),
					},
					sessionId,
				)
				return { content: [{ type: "text" as const, text: `TODO ${params.todo_id} completed. ${evidence}` }], details }
			},
		}),
	)
}
