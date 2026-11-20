import type { AgentSideConnection, PermissionOption, ToolCall } from "@agentclientprotocol/sdk"
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { getSessionState as getBashSessionState } from "../../extensions/bash-background/session-registry.js"
import {
	isModeChangeAbort,
	type PermissionChoice,
	type ToolPermissionPrompter,
} from "../../extensions/permissions/prompter.js"
import type { ApprovalOutcome } from "../../extensions/permissions/prompts.js"
import { EXEC_DEREF_TOOLS, substituteTokensDeep, vaultForSession } from "../../extensions/pii-redaction/vault.js"
import { buildToolCallShape, buildToolCallUpdate } from "./tool-calls/utils.js"
import { requestWithAbort } from "./utils.js"

export type AcpToolCallIdResolver = (piToolCallId: string, toolName: string, agentId?: string) => string
export type AcpToolCallIdReleaser = (piToolCallId: string, agentId: string) => void

/**
 * Added to the title of a subagent's card that a mode change withdrew. ACP has
 * no "cancelled" tool-call status, so the card closes as failed; the title is
 * the only place to say that nobody refused the call and that it is decided
 * again under the new mode.
 */
export const WITHDRAWN_BY_MODE_CHANGE_SUFFIX = " — withdrawn: permission mode changed"

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
			// The client never gets a tool_call stream for an escalated subagent
			// call, so its permission card would stay "pending" unless it is closed
			// here. That has to happen on EVERY way out, also when the request
			// rejects or the client answers with something unreadable.
			let outcome: ApprovalOutcome | undefined
			try {
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
								const feedback = await uiContext.input("Tell the assistant what to do differently:", undefined, {
									signal: req.signal,
								})
								const text = feedback?.trim()
								outcome = text ? { kind: "deny-with-feedback", feedback: text } : { kind: "deny" }
								break
							}
						}
					}
				}
				return outcome
			} finally {
				if (req.origin) {
					// Completed on allow, failed on everything else: deny, cancel,
					// abort, or an error (no outcome). A card withdrawn by a mode
					// change is not a refusal — the call is decided again under the
					// new mode and may well run — so its title says what happened.
					const withdrawn = outcome?.kind === "aborted" && isModeChangeAbort(req.signal)
					// Closing is best effort: the decision is already settled and must
					// never be changed by a failed update.
					try {
						await conn.sessionUpdate({
							sessionId,
							update: buildToolCallUpdate({
								toolCallId: acpToolCallId,
								piToolCallId: req.toolCallId,
								status: outcome?.kind.startsWith("allow") ? "completed" : "failed",
								title: withdrawn ? `${toolCall.title}${WITHDRAWN_BY_MODE_CHANGE_SUFFIX}` : toolCall.title,
								kind: toolCall.kind,
							}),
						})
					} catch {
						// The parent route still receives the actual approval outcome.
					}
				}
			}
		},
	}
}
