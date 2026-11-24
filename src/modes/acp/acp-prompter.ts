import {
	type AgentContext,
	methods,
	type PermissionOption,
	type ToolCall,
	type ToolKind,
} from "@agentclientprotocol/sdk/unstable"
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { getSessionState as getBashSessionState } from "../../extensions/bash-background/session-registry.js"
import type { PermissionChoice, ToolPermissionPrompter } from "../../extensions/permissions/prompter.js"
import type { ApprovalOutcome } from "../../extensions/permissions/prompts.js"
import { EXEC_DEREF_TOOLS, substituteTokensDeep, vaultForSession } from "../../extensions/pii-redaction/vault.js"
import { buildToolCallShape, buildToolCallUpdate } from "./tool-calls/utils.js"
import { requestWithAbort } from "./utils.js"

export type AcpToolCallIdResolver = (piToolCallId: string, toolName: string, agentId?: string) => string
export type AcpToolCallIdReleaser = (piToolCallId: string, agentId: string) => void

/** A subagent's call that the client was asked about and that has not ended yet. */
interface OpenCard {
	acpToolCallId: string
	title: string
	kind: ToolKind | null | undefined
}

function cardKey(piToolCallId: string, agentId: string | undefined): string {
	return `${agentId ?? ""}:${piToolCallId}`
}

export function createAcpPermissionPrompter(
	conn: AgentContext,
	sessionId: string,
	uiContext: ExtensionUIContext,
	resolveAcpToolCallId: AcpToolCallIdResolver,
	cwd?: string,
	releaseAcpToolCallId?: AcpToolCallIdReleaser,
): ToolPermissionPrompter {
	// The client never gets a tool_call stream for a subagent's call: the
	// permission request is the only thing it sees of it. The answer settles
	// the approval, not the call, so the card's status is sent from what the
	// worker reports afterwards (reportEscalatedCall) and never from the answer.
	const openCards = new Map<string, OpenCard>()
	return {
		reportEscalatedCall(report): void {
			const key = cardKey(report.toolCallId, report.agentId)
			const card = openCards.get(key)
			// No card: the request was never sent, or the call already ended.
			if (!card) return
			if (report.status !== "running") {
				openCards.delete(key)
				// The call owns its composite ID until it has ended.
				if (report.agentId) releaseAcpToolCallId?.(report.toolCallId, report.agentId)
			}
			conn
				.notify(methods.client.session.update, {
					sessionId,
					update: buildToolCallUpdate({
						toolCallId: card.acpToolCallId,
						piToolCallId: report.toolCallId,
						status: report.status === "running" ? "in_progress" : report.status,
						title: card.title,
						kind: card.kind ?? undefined,
					}),
				})
				.catch(() => {
					// Display only: the call's outcome does not depend on it.
				})
		},
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
			// From here the client has (or is about to get) a card for this call.
			// A request for the same call after a mode change reuses the card.
			if (req.origin) {
				openCards.set(cardKey(req.toolCallId, req.origin.agentId), {
					acpToolCallId,
					title: toolCall.title,
					kind: toolCall.kind,
				})
			}
			const response = await requestWithAbort(
				conn.request(methods.client.session.requestPermission, { sessionId, toolCall, options }),
				req.signal,
			)

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
					const feedback = await uiContext.input("Tell the assistant what to do differently:", undefined, {
						signal: req.signal,
					})
					const text = feedback?.trim()
					return text ? { kind: "deny-with-feedback", feedback: text } : { kind: "deny" }
				}
			}
		},
	}
}
