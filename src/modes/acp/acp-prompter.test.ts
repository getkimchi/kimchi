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

describe("escalated subagent requests", () => {
	const originReq = {
		...baseReq,
		origin: { persona: "General-Purpose", agentId: "agent-1", description: "write the file" },
	}

	function makeRecordingConnection(outcome: { outcome: string; optionId?: string }) {
		const permissionPayloads: Array<{ sessionId: string; toolCall: ToolCall }> = []
		const updates: Array<{ sessionId: string; update: Record<string, unknown> }> = []
		const conn = {
			requestPermission: vi.fn(async (payload: { sessionId: string; toolCall: ToolCall }) => {
				permissionPayloads.push(payload)
				return { outcome }
			}),
			sessionUpdate: vi.fn(async (payload: { sessionId: string; update: Record<string, unknown> }) => {
				updates.push(payload)
			}),
		} as unknown as AgentSideConnection
		return { conn, permissionPayloads, updates }
	}

	it("names the subagent in the title and _meta, keys the card id by agent, and closes completed", async () => {
		const { conn, permissionPayloads, updates } = makeRecordingConnection({
			outcome: "outcome_selected",
			optionId: "choice-0",
		})
		const resolver = vi.fn(() => "acp-escalated")
		const prompter = createAcpPermissionPrompter(conn, "sess-1", {} as never, resolver)
		const outcome = await prompter.request(originReq)
		expect(outcome).toEqual({ kind: "allow-once" })

		expect(resolver).toHaveBeenCalledWith("tc-1", "bash", "agent-1")
		const card = permissionPayloads[0]?.toolCall
		expect(card?.title).toMatch(/^Subagent General-Purpose: /)
		expect((card?._meta?.["kimchi.dev"] as { subagent?: unknown }).subagent).toEqual({
			persona: "General-Purpose",
			agentId: "agent-1",
		})

		const closes = updates.filter((u) => u.update.sessionUpdate === "tool_call_update")
		expect(closes).toHaveLength(1)
		expect(closes[0]?.update).toMatchObject({ toolCallId: "acp-escalated", status: "completed" })
		expect((closes[0]?.update.title as string) ?? "").toMatch(/^Subagent General-Purpose: /)
	})

	it("closes the card as failed when the client cancels an escalated request", async () => {
		const { conn, updates } = makeRecordingConnection({ outcome: "cancelled" })
		const prompter = createAcpPermissionPrompter(conn, "sess-1", {} as never, () => "acp-escalated")
		const outcome = await prompter.request(originReq)
		expect(outcome).toEqual({ kind: "denied-by-client" })

		const closes = updates.filter((u) => u.update.sessionUpdate === "tool_call_update")
		expect(closes).toHaveLength(1)
		expect(closes[0]?.update).toMatchObject({ toolCallId: "acp-escalated", status: "failed" })
	})

	it("keeps the main session's own cards unchanged (no title prefix, no closing update)", async () => {
		const { conn, permissionPayloads, updates } = makeRecordingConnection({
			outcome: "outcome_selected",
			optionId: "choice-0",
		})
		const resolver = vi.fn(() => "acp-1")
		const prompter = createAcpPermissionPrompter(conn, "sess-1", {} as never, resolver)
		await prompter.request(baseReq)

		expect(resolver).toHaveBeenCalledWith("tc-1", "bash", undefined)
		expect(permissionPayloads[0]?.toolCall.title).not.toMatch(/^Subagent /)
		expect(updates).toHaveLength(0)
	})

	it("preserves an allow and releases the id when the closing update fails", async () => {
		const { conn } = makeRecordingConnection({ outcome: "outcome_selected", optionId: "choice-0" })
		vi.mocked(conn.sessionUpdate).mockRejectedValue(new Error("client disconnected"))
		const release = vi.fn()
		const prompter = createAcpPermissionPrompter(conn, "sess-1", {} as never, () => "acp-escalated", undefined, release)

		expect(await prompter.request(originReq)).toEqual({ kind: "allow-once" })
		expect(release).toHaveBeenCalledWith("tc-1", "agent-1")
	})

	it.each([
		{ name: "deny", outcome: { outcome: "outcome_selected", optionId: "choice-1" } },
		{ name: "cancel", outcome: { outcome: "cancelled" } },
	])("releases the id after $name", async ({ outcome }) => {
		const { conn } = makeRecordingConnection(outcome)
		const release = vi.fn()
		const uiContext = { input: vi.fn(async () => "") } as never
		const prompter = createAcpPermissionPrompter(conn, "sess-1", uiContext, () => "acp-escalated", undefined, release)

		await prompter.request(originReq)
		expect(release).toHaveBeenCalledWith("tc-1", "agent-1")
	})

	it("releases the id when an in-flight prompt is aborted", async () => {
		const controller = new AbortController()
		const conn = {
			requestPermission: vi.fn(async () => new Promise(() => {})),
			sessionUpdate: vi.fn(async () => {}),
		} as unknown as AgentSideConnection
		const release = vi.fn()
		const prompter = createAcpPermissionPrompter(conn, "sess-1", {} as never, () => "acp-escalated", undefined, release)
		const pending = prompter.request({ ...originReq, signal: controller.signal })
		controller.abort()

		expect(await pending).toEqual({ kind: "aborted" })
		expect(release).toHaveBeenCalledWith("tc-1", "agent-1")
	})

	it("releases the id when the permission request rejects", async () => {
		const conn = {
			requestPermission: vi.fn(async () => {
				throw new Error("request failed")
			}),
			sessionUpdate: vi.fn(async () => {}),
		} as unknown as AgentSideConnection
		const release = vi.fn()
		const prompter = createAcpPermissionPrompter(conn, "sess-1", {} as never, () => "acp-escalated", undefined, release)

		await expect(prompter.request(originReq)).rejects.toThrow("request failed")
		expect(release).toHaveBeenCalledWith("tc-1", "agent-1")
	})
})
