import type { AgentSideConnection, PermissionOption, ToolCall } from "@agentclientprotocol/sdk"
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { getSessionState as getBashSessionState } from "../../extensions/bash-background/session-registry.js"
import type { PermissionChoice, ToolPermissionPrompter } from "../../extensions/permissions/prompter.js"
import type { ApprovalOutcome } from "../../extensions/permissions/prompts.js"
import { EXEC_DEREF_TOOLS, substituteTokensDeep, vaultForSession } from "../../extensions/pii-redaction/vault.js"
import { buildToolCallShape, buildToolCallUpdate } from "./tool-calls/utils.js"
import { requestWithAbort } from "./utils.js"

export type AcpToolCallIdResolver = (piToolCallId: string, toolName: string, agentId?: string) => string
export type AcpToolCallIdReleaser = (piToolCallId: string, agentId: string) => void

export function createAcpPermissionPrompter(
	conn: AgentSideConnection,
	sessionId: string,
	uiContext: ExtensionUIContext,
	resolveAcpToolCallId: AcpToolCallIdResolver,
	cwd?: string,
	releaseAcpToolCallId?: AcpToolCallIdReleaser,
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

			const acpToolCallId = resolveAcpToolCallId(req.toolCallId, req.toolName, req.origin?.agentId)
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
				// The approval card must mirror the tool_call stream events: the
				// wait's target cohort rides _meta via this same builder, fed the
				// same live registry — approving an un-adorned call while the
				// timeline names its cohort would show two different actions.
				bashControlRegistry: getBashSessionState(sessionId)?.registry,
			})
			// Escalated subagent requests are reachable only here (the client never
			// sees a tool_call stream for the child's call), so the card has to name
			// the subagent for clients that ignore _meta, and carry the identity in
			// _meta for clients that don't.
			if (req.origin) {
				const persona = req.origin.persona ?? "assistant"
				toolCall.title = `Subagent ${persona}: ${toolCall.title}`
				const kimchiMeta = (toolCall._meta?.["kimchi.dev"] as Record<string, unknown> | undefined) ?? {}
				toolCall._meta = {
					...toolCall._meta,
					"kimchi.dev": {
						...kimchiMeta,
						subagent: { persona, agentId: req.origin.agentId ?? null },
					},
				}
			}
			const response = await requestWithAbort(
				conn.requestPermission({ sessionId, toolCall, options }),
				req.signal,
			).finally(() => {
				// A permission request owns its composite ID only until it settles.
				if (req.origin?.agentId) releaseAcpToolCallId?.(req.toolCallId, req.origin.agentId)
			})

			// A cancelled response means the CLIENT denied without a human
			// choice — headless ACP hosts fail permission requests
			// fail-safe. This must NOT report "aborted": the caller's
			// re-evaluation loop treats aborted as "permission mode changed,
			// retry under the new mode", so a deterministic denial would
			// loop to its cap and surface the misleading "Permission mode
			// changed too many times during prompt" error. Report a clean
			// denial so the model gets one actionable rejection.
			let outcome: ApprovalOutcome
			if (response === "aborted") {
				outcome = { kind: "aborted" }
			} else if (response.outcome.outcome === "cancelled") {
				outcome = { kind: "denied-by-client" }
			} else {
				const selected = optionById.get(response.outcome.optionId)
				if (!selected) {
					outcome = { kind: "deny" }
				} else {
					switch (selected.kind) {
						case "allow-once":
							outcome = { kind: "allow-once" }
							break
						case "allow-remember":
							outcome = { kind: "allow-remember", rules: selected.rules }
							break
						case "allow-remember-wildcard":
							outcome = { kind: "allow-remember-wildcard", rules: selected.rules }
							break
						case "deny": {
							const feedback = await uiContext.input("Tell the assistant what to do differently:")
							const text = feedback?.trim()
							outcome = text ? { kind: "deny-with-feedback", feedback: text } : { kind: "deny" }
							break
						}
					}
				}
			}

			// The client never gets a tool_call stream for an escalated subagent
			// call, so without this update its permission card would stay "pending"
			// after the answer. Close it explicitly: completed on allow, failed on
			// deny / cancel / abort. Closing is best effort: the user's decision is
			// already settled and must never be changed by a failed update.
			if (req.origin) {
				try {
					await conn.sessionUpdate({
						sessionId,
						update: buildToolCallUpdate({
							toolCallId: acpToolCallId,
							piToolCallId: req.toolCallId,
							status: outcome.kind.startsWith("allow") ? "completed" : "failed",
							title: toolCall.title,
							kind: toolCall.kind,
						}),
					})
				} catch {
					// The parent route still receives the actual approval outcome.
				}
			}
			return outcome
		},
	}
}
