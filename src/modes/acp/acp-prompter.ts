import type { AgentSideConnection, PermissionOption, ToolCallUpdate } from "@agentclientprotocol/sdk"
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import type { PermissionChoice, ToolPermissionPrompter } from "../../extensions/permissions/prompter.js"
import type { ApprovalOutcome } from "../../extensions/permissions/prompts.js"
import { requestWithAbort } from "./utils.js"

export type ToolCallUpdateBuilder = (
	toolCallId: string,
	toolName: string,
	input: Record<string, unknown>,
) => ToolCallUpdate

export function createAcpPermissionPrompter(
	conn: AgentSideConnection,
	sessionId: string,
	uiContext: ExtensionUIContext,
	buildToolCallUpdate: ToolCallUpdateBuilder,
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

			const response = await requestWithAbort(
				conn.requestPermission({
					sessionId,
					toolCall: buildToolCallUpdate(req.toolCallId, req.toolName, req.input),
					options,
				}),
				req.signal,
			)

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
