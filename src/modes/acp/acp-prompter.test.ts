import type { AgentSideConnection, ToolCall } from "@agentclientprotocol/sdk"
import { describe, expect, it, vi } from "vitest"
import { createAcpPermissionPrompter } from "./acp-prompter.js"

// Regression guard for the ACP permission flap: a client-cancelled
// permission request must surface as a distinct denial outcome, NOT as
// "aborted" — the permission gate's re-evaluation loop treats aborted as
// "mode changed, retry", so the old mapping looped to its cap and failed
// the tool call with "Permission mode changed too many times during
// prompt" (observed from Hermes' ACP shim, which cancels fail-safe).

function makeConnection(outcome: { outcome: string; optionId?: string } | "cancelled-throw") {
	return {
		requestPermission: vi.fn(async () => {
			if (outcome === "cancelled-throw") throw new Error("should not happen")
			return { outcome }
		}),
	} as unknown as AgentSideConnection
}

const baseReq = {
	toolCallId: "tc-1",
	toolName: "bash",
	input: { command: "echo hi" },
	choices: [
		{ kind: "allow-once" as const, label: "Yes — just this call" },
		{ kind: "deny" as const, label: "No" },
	],
}

describe("acp-prompter cancelled-request mapping", () => {
	it("maps a cancelled ACP response to denied-by-client (not aborted)", async () => {
		const conn = makeConnection({ outcome: "cancelled" })
		const prompter = createAcpPermissionPrompter(conn, "sess-1", {} as never, () => "acp-1")
		const outcome = await prompter.request(baseReq)
		expect(outcome).toEqual({ kind: "denied-by-client" })
	})

	it("keeps a real abort (signal) mapped to aborted", async () => {
		const conn = makeConnection({ outcome: "cancelled" })
		const prompter = createAcpPermissionPrompter(conn, "sess-1", {} as never, () => "acp-1")
		const controller = new AbortController()
		controller.abort()
		const outcome = await prompter.request({ ...baseReq, signal: controller.signal })
		expect(outcome).toEqual({ kind: "aborted" })
	})

	it("still maps selected options to their choices", async () => {
		const conn = makeConnection({ outcome: "outcome_selected", optionId: "choice-0" })
		const prompter = createAcpPermissionPrompter(conn, "sess-1", {} as never, () => "acp-1")
		const outcome = await prompter.request(baseReq)
		expect(outcome).toEqual({ kind: "allow-once" })
	})
})

describe("request_permission payloads stay tokenized (redaction guardrail)", () => {
	it("sends vault tokens verbatim — approvals must show what executes", async () => {
		const sent: Array<{ sessionId: string; toolCall: ToolCall }> = []
		const conn = {
			requestPermission: vi.fn(async (payload: { sessionId: string; toolCall: ToolCall }) => {
				sent.push(payload)
				return { outcome: { outcome: "cancelled" } }
			}),
		} as unknown as AgentSideConnection
		const prompter = createAcpPermissionPrompter(conn, "sess-1", {} as never, () => "acp-1")
		const token = "[EMAIL_ADDRESS_3]"
		const outcome = await prompter.request({
			...baseReq,
			toolName: "bash",
			input: { command: `mail ${token}` },
		})
		expect(outcome).toEqual({ kind: "denied-by-client" })
		// The prompt is a decision about EXECUTION, and what executes is the
		// literal token: title and rawInput must carry it verbatim, never the
		// original it stands for (docs/pii-redaction-tokens.md).
		expect(sent).toHaveLength(1)
		expect(sent[0]?.toolCall.rawInput).toEqual({ command: `mail ${token}` })
		expect(sent[0]?.toolCall.title).toBe(`mail ${token}`)
	})
})
