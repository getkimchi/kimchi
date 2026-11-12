import type { AgentSideConnection, ToolCall } from "@agentclientprotocol/sdk"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../../extensions/__mocks__/context.js"
import { createExtensionApi } from "../../extensions/__mocks__/extension-api.js"
import { setSessionState } from "../../extensions/bash-background/session-registry.js"
import {
	installVaultLifecycle,
	resetTokenVaults,
	tokenFor,
	vaultForSession,
} from "../../extensions/pii-redaction/vault.js"
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

describe("request_permission payloads mirror execution (redaction guardrail)", () => {
	beforeEach(() => {
		resetTokenVaults()
	})

	it("edit/write prompts substitute with a live vault (execution derefs; the original is what lands)", async () => {
		const sent: Array<{ sessionId: string; toolCall: ToolCall }> = []
		const conn = {
			requestPermission: vi.fn(async (payload: { sessionId: string; toolCall: ToolCall }) => {
				sent.push(payload)
				return { outcome: { outcome: "cancelled" } }
			}),
		} as unknown as AgentSideConnection
		const { api, emit } = createExtensionApi()
		installVaultLifecycle(api as never, () => true)
		await emit("session_start", {}, createContext({ sessionManager: { getSessionId: () => "sess-edit" } }))
		const vault = vaultForSession("sess-edit")
		if (!vault) throw new Error("vault missing")
		const original = "[EMAIL_ADDRESS_51]"
		const token = tokenFor(vault, "EMAIL_ADDRESS", original)
		const prompter = createAcpPermissionPrompter(conn, "sess-edit", {} as never, () => "acp-1")
		await prompter.request({
			...baseReq,
			toolName: "edit",
			input: { path: "c.txt", oldText: token, newText: token },
		})
		expect(sent).toHaveLength(1)
		expect(sent[0]?.toolCall.rawInput).toEqual({ path: "c.txt", oldText: original, newText: original })
	})

	it("bash prompts keep tokens even with a live vault (execution is byte-faithful)", async () => {
		const sent: Array<{ sessionId: string; toolCall: ToolCall }> = []
		const conn = {
			requestPermission: vi.fn(async (payload: { sessionId: string; toolCall: ToolCall }) => {
				sent.push(payload)
				return { outcome: { outcome: "cancelled" } }
			}),
		} as unknown as AgentSideConnection
		const { api, emit } = createExtensionApi()
		installVaultLifecycle(api as never, () => true)
		await emit("session_start", {}, createContext({ sessionManager: { getSessionId: () => "sess-bash" } }))
		const vault = vaultForSession("sess-bash")
		if (!vault) throw new Error("vault missing")
		const original = "[EMAIL_ADDRESS_50]"
		const token = tokenFor(vault, "EMAIL_ADDRESS", original)
		const prompter = createAcpPermissionPrompter(conn, "sess-bash", {} as never, () => "acp-1")
		await prompter.request({
			...baseReq,
			toolName: "bash",
			input: { command: `mail ${token}` },
		})
		expect(sent).toHaveLength(1)
		expect(sent[0]?.toolCall.rawInput).toEqual({ command: `mail ${token}` })
		expect(sent[0]?.toolCall.title).toBe(`mail ${token}`)
	})

	it("edit prompt with a dead vault (post-restart) renders tokens verbatim", async () => {
		const sent: Array<{ sessionId: string; toolCall: ToolCall }> = []
		const conn = {
			requestPermission: vi.fn(async (payload: { sessionId: string; toolCall: ToolCall }) => {
				sent.push(payload)
				return { outcome: { outcome: "cancelled" } }
			}),
		} as unknown as AgentSideConnection
		const token = "[EMAIL_ADDRESS_41]"
		const prompter = createAcpPermissionPrompter(conn, "dead-sess", {} as never, () => "acp-1")
		await prompter.request({
			...baseReq,
			toolName: "edit",
			input: { path: "c.txt", oldText: token, newText: token },
		})
		expect(sent).toHaveLength(1)
		expect(sent[0]?.toolCall.rawInput).toEqual({ path: "c.txt", oldText: token, newText: token })
	})

	/* The original single-purpose guardrail below predates the mirror rule; it
	 * pins the byte-faithful branch of the same contract the "edit/write"
	 * test pins for derefed tools. */

	it("sends vault tokens verbatim for byte-faithful tools — approvals show what executes", async () => {
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

	it("bash_control wait prompts keep rawInput as agent input; live cohort rides _meta when a registry is live", async () => {
		setSessionState("sess-wait", {
			registry: {
				displaySnapshot: () => ({
					handle: "h1",
					state: "running",
					command: "sleep 60",
					startedAt: Date.now() - 1000,
					observedAt: Date.now(),
				}),
				listDisplaySnapshots: () => [
					{ handle: "h1", state: "running", command: "sleep 60", startedAt: Date.now() - 1000, observedAt: Date.now() },
				],
			},
			limitSeconds: 60,
			sessionKind: "on-demand",
		} as never)
		try {
			const sent: Array<{ sessionId: string; toolCall: ToolCall }> = []
			const conn = {
				requestPermission: vi.fn(async (payload: { sessionId: string; toolCall: ToolCall }) => {
					sent.push(payload)
					return { outcome: { outcome: "cancelled" } }
				}),
			} as unknown as AgentSideConnection
			const prompter = createAcpPermissionPrompter(conn, "sess-wait", {} as never, () => "acp-1")
			await prompter.request({
				...baseReq,
				toolName: "bash_control",
				input: { wait: true, handles: ["h1"] },
			})
			expect(sent).toHaveLength(1)
			expect(sent[0]?.toolCall.rawInput).toEqual({ wait: true, handles: ["h1"] })
			expect(
				(sent[0]?.toolCall._meta as { bashControlWait?: { commands?: unknown[] } } | undefined)?.bashControlWait,
			).toEqual({
				commands: [expect.objectContaining({ command: "sleep 60" })],
				elapsedSeconds: expect.any(Number),
			})
		} finally {
			setSessionState("sess-wait", undefined)
		}
	})
})
