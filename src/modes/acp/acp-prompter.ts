import type { AgentSideConnection, PermissionOption, ToolCall } from "@agentclientprotocol/sdk"
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import type { PermissionChoice, ToolPermissionPrompter } from "../../extensions/permissions/prompter.js"
import type { ApprovalOutcome } from "../../extensions/permissions/prompts.js"
import { EXEC_DEREF_TOOLS, substituteTokensDeep, vaultForSession } from "../../extensions/pii-redaction/vault.js"
import { buildToolCallShape } from "./tool-calls/utils.js"
import { requestWithAbort } from "./utils.js"

export type AcpToolCallIdResolver = (piToolCallId: string, toolName: string) => string

export function createAcpPermissionPrompter(
	conn: AgentSideConnection,
	sessionId: string,
	uiContext: ExtensionUIContext,
	resolveAcpToolCallId: AcpToolCallIdResolver,
	cwd?: string,
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
			// The approval must mirror what execution will DO with the args:
			// byte-faithful tools (bash, MCP…) run the literal token, so the
			// prompt shows the token; edit/write deref at execute time
			// (EXEC_DEREF_TOOLS), so the prompt shows the original — that is
			// the content the approval actually writes.
			let rawInput = req.input
			if (EXEC_DEREF_TOOLS.has(req.toolName)) {
				const vault = vaultForSession(sessionId)
				if (vault && rawInput && typeof rawInput === "object") {
					rawInput = substituteTokensDeep(vault, rawInput) as typeof rawInput
				}
			}
			const toolCall: ToolCall = buildToolCallShape({
				toolCallId: acpToolCallId,
				piToolCallId: req.toolCallId,
				toolName: req.toolName,
				rawInput,
				status: "pending",
				cwd,
			})
			const response = await requestWithAbort(conn.requestPermission({ sessionId, toolCall, options }), req.signal)

			// A cancelled response means the CLIENT denied without a human
			// choice — headless ACP hosts fail permission requests
			// fail-safe. This must NOT report "aborted": the caller's
			// re-evaluation loop treats aborted as "permission mode changed,
			// retry under the new mode", so a deterministic denial would
			// loop to its cap and surface the misleading "Permission mode
			// changed too many times during prompt" error. Report a clean
			// denial so the model gets one actionable rejection.
			if (response === "aborted") return { kind: "aborted" }
			if (response.outcome.outcome === "cancelled") return { kind: "denied-by-client" }

			const selected = optionById.get(response.outcome.optionId)
			if (!selected) return { kind: "deny" }

			switch (selected.kind) {
				case "allow-once":
					return { kind: "allow-once" }
				case "allow-remember":
					return { kind: "allow-remember", rules: selected.rules }
				case "allow-remember-wildcard":
					return { kind: "allow-remember-wildcard", rules: selected.rules }
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
