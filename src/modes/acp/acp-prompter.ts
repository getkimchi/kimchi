import type { AgentSideConnection, PermissionOption, ToolCall } from "@agentclientprotocol/sdk"
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import type { PermissionChoice, ToolPermissionPrompter } from "../../extensions/permissions/prompter.js"
import type { ApprovalOutcome } from "../../extensions/permissions/prompts.js"
import { buildToolCallShape } from "./tool-calls/utils.js"
import { requestWithAbort } from "./utils.js"

export type AcpToolCallIdResolver = (piToolCallId: string, toolName: string) => string

export function createAcpPermissionPrompter(
	conn: AgentSideConnection,
	sessionId: string,
	uiContext: ExtensionUIContext,
	resolveAcpToolCallId: AcpToolCallIdResolver,
): ToolPermissionPrompter {
	return {
		async request(req): Promise<ApprovalOutcome> {
			if (req.signal?.aborted) return { kind: "aborted" }

			const optionById = new Map<string, PermissionChoice>()
			const options: PermissionOption[] = req.choices.map((choice, index) => {
				const optionId = `choice-${index}`
				optionById.set(optionId, choice)
				return {
					optionId,
					name: choice.label,
					kind: choice.kind === "deny" ? "reject_once" : choice.kind === "allow-once" ? "allow_once" : "allow_always",
				}
			})

			const acpToolCallId = resolveAcpToolCallId(req.toolCallId, req.toolName)
			const toolCall: ToolCall = buildToolCallShape({
				toolCallId: acpToolCallId,
				piToolCallId: req.toolCallId,
				toolName: req.toolName,
				rawInput: req.input,
				status: "pending",
			})
			const response = await requestWithAbort(conn.requestPermission({ sessionId, toolCall, options }), req.signal)

			if (response === "aborted" || response.outcome.outcome === "cancelled") return { kind: "aborted" }

			const selected = optionById.get(response.outcome.optionId)
			if (!selected) return { kind: "deny" }

			switch (selected.kind) {
				case "allow-once":
					return { kind: "allow-once" }
				case "allow-remember":
					return { kind: "allow-remember", rule: selected.rule }
				case "allow-remember-wildcard":
					return { kind: "allow-remember-wildcard", rule: selected.rule }
				case "deny": {
					const feedback = await uiContext.input("Tell the assistant what to do differently:")
					const text = feedback?.trim()
					if (text) return { kind: "deny-with-feedback", feedback: text }
					return { kind: "deny" }
				}
			}
		},
	}
}
