import type { AgentContext, ToolCall } from "@agentclientprotocol/sdk/unstable"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../../extensions/__mocks__/context.js"
import { createExtensionApi } from "../../extensions/__mocks__/extension-api.js"
import { setSessionState } from "../../extensions/bash-background/session-registry.js"
import { MODE_CHANGED_ABORT_ERROR } from "../../extensions/permissions/prompter.js"
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
		request: vi.fn(async () => {
			if (outcome === "cancelled-throw") throw new Error("should not happen")
			return { outcome }
		}),
	} as unknown as AgentContext
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

	it("carries the abort signal through feedback input into a plain denial", async () => {
		const conn = makeConnection({ outcome: "selected", optionId: "choice-1" })
		const controller = new AbortController()
		let resolveFeedback!: () => void
		const pendingFeedback = new Promise<string>((resolve) => {
			resolveFeedback = () => resolve("")
		})
		const input = vi.fn(() => pendingFeedback)
		const prompter = createAcpPermissionPrompter(conn, "sess-1", { input } as never, () => "acp-1")
		const pending = prompter.request({ ...baseReq, signal: controller.signal })
		await vi.waitFor(() => expect(input).toHaveBeenCalledOnce())
		controller.abort()
		resolveFeedback()

		expect(await pending).toEqual({ kind: "deny" })
		expect(input).toHaveBeenCalledWith(expect.any(String), undefined, { signal: controller.signal })
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
		const conn = makeConnection({ outcome: "selected", optionId: "choice-0" })
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
			request: vi.fn(async (_method: string, payload: { sessionId: string; toolCall: ToolCall }) => {
				sent.push(payload)
				return { outcome: { outcome: "cancelled" } }
			}),
		} as unknown as AgentContext
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
			request: vi.fn(async (_method: string, payload: { sessionId: string; toolCall: ToolCall }) => {
				sent.push(payload)
				return { outcome: { outcome: "cancelled" } }
			}),
		} as unknown as AgentContext
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
			request: vi.fn(async (_method: string, payload: { sessionId: string; toolCall: ToolCall }) => {
				sent.push(payload)
				return { outcome: { outcome: "cancelled" } }
			}),
		} as unknown as AgentContext
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
			request: vi.fn(async (_method: string, payload: { sessionId: string; toolCall: ToolCall }) => {
				sent.push(payload)
				return { outcome: { outcome: "cancelled" } }
			}),
		} as unknown as AgentContext
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
				request: vi.fn(async (_method: string, payload: { sessionId: string; toolCall: ToolCall }) => {
					sent.push(payload)
					return { outcome: { outcome: "cancelled" } }
				}),
			} as unknown as AgentContext
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
			request: vi.fn(async (_method: string, payload: { sessionId: string; toolCall: ToolCall }) => {
				permissionPayloads.push(payload)
				return { outcome }
			}),
			notify: vi.fn(async (_method: string, payload: { sessionId: string; update: Record<string, unknown> }) => {
				updates.push(payload)
			}),
		} as unknown as AgentContext
		return { conn, permissionPayloads, updates }
	}

	const statusUpdates = (updates: Array<{ update: Record<string, unknown> }>) =>
		updates.filter((u) => u.update.sessionUpdate === "tool_call_update").map((u) => u.update)

	it("names the subagent in the title and _meta and keys the card id by agent", async () => {
		const { conn, permissionPayloads } = makeRecordingConnection({
			outcome: "selected",
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
	})

	it("keeps the main session's own cards unchanged (no title prefix, no status update)", async () => {
		const { conn, permissionPayloads, updates } = makeRecordingConnection({
			outcome: "selected",
			optionId: "choice-0",
		})
		const resolver = vi.fn(() => "acp-1")
		const prompter = createAcpPermissionPrompter(conn, "sess-1", {} as never, resolver)
		await prompter.request(baseReq)
		prompter.reportEscalatedCall?.({ toolCallId: "tc-1", status: "completed" })

		expect(resolver).toHaveBeenCalledWith("tc-1", "bash", undefined)
		expect(permissionPayloads[0]?.toolCall.title).not.toMatch(/^Subagent /)
		expect(updates).toHaveLength(0)
	})

	// The client never sees a tool_call stream for a subagent's call. The
	// answer to the request settles the approval only; the card's status comes
	// from what the worker reports about the call itself.
	describe("the card follows the call, not the answer", () => {
		const report = (
			prompter: ReturnType<typeof createAcpPermissionPrompter>,
			status: "running" | "completed" | "failed",
			agentId = "agent-1",
		) => prompter.reportEscalatedCall?.({ toolCallId: "tc-1", agentId, status })

		it.each([
			{ name: "allow", outcome: { outcome: "selected", optionId: "choice-0" } },
			{ name: "deny", outcome: { outcome: "selected", optionId: "choice-1" } },
			{ name: "cancel", outcome: { outcome: "cancelled" } },
		])("sends no status and keeps the id after $name alone", async ({ outcome }) => {
			const { conn, updates } = makeRecordingConnection(outcome)
			const release = vi.fn()
			const uiContext = { input: vi.fn(async () => "") } as never
			const prompter = createAcpPermissionPrompter(conn, "sess-1", uiContext, () => "acp-escalated", undefined, release)

			await prompter.request(originReq)
			expect(statusUpdates(updates)).toHaveLength(0)
			expect(release).not.toHaveBeenCalled()
		})

		it.each([
			"completed",
			"failed",
		] as const)("shows an allowed call in progress, then %s once it has really ended", async (ending) => {
			const { conn, updates } = makeRecordingConnection({ outcome: "selected", optionId: "choice-0" })
			const release = vi.fn()
			const prompter = createAcpPermissionPrompter(
				conn,
				"sess-1",
				{} as never,
				() => "acp-escalated",
				undefined,
				release,
			)
			expect(await prompter.request(originReq)).toEqual({ kind: "allow-once" })

			report(prompter, "running")
			expect(statusUpdates(updates)).toEqual([
				expect.objectContaining({ toolCallId: "acp-escalated", status: "in_progress" }),
			])
			expect(release).not.toHaveBeenCalled()

			report(prompter, ending)
			expect(statusUpdates(updates)).toHaveLength(2)
			expect(statusUpdates(updates)[1]).toMatchObject({ toolCallId: "acp-escalated", status: ending })
			expect(statusUpdates(updates)[1]?.title).toMatch(/^Subagent General-Purpose: /)
			expect(release).toHaveBeenCalledExactlyOnceWith("tc-1", "agent-1")
		})

		it("closes a refused call as failed when the worker reports the block", async () => {
			const { conn, updates } = makeRecordingConnection({ outcome: "cancelled" })
			const release = vi.fn()
			const prompter = createAcpPermissionPrompter(
				conn,
				"sess-1",
				{} as never,
				() => "acp-escalated",
				undefined,
				release,
			)
			expect(await prompter.request(originReq)).toEqual({ kind: "denied-by-client" })

			report(prompter, "failed")
			expect(statusUpdates(updates)).toEqual([
				expect.objectContaining({ toolCallId: "acp-escalated", status: "failed" }),
			])
			expect(release).toHaveBeenCalledExactlyOnceWith("tc-1", "agent-1")
		})

		it("closes the card when the request itself failed and the worker then blocks the call", async () => {
			const updates: Array<{ update: Record<string, unknown> }> = []
			const conn = {
				request: vi.fn(async () => {
					throw new Error("request failed")
				}),
				notify: vi.fn(async (_method: string, payload: { update: Record<string, unknown> }) => {
					updates.push(payload)
				}),
			} as unknown as AgentContext
			const release = vi.fn()
			const prompter = createAcpPermissionPrompter(
				conn,
				"sess-1",
				{} as never,
				() => "acp-escalated",
				undefined,
				release,
			)

			await expect(prompter.request(originReq)).rejects.toThrow("request failed")
			expect(statusUpdates(updates)).toHaveLength(0)
			report(prompter, "failed")
			expect(statusUpdates(updates)).toEqual([
				expect.objectContaining({ toolCallId: "acp-escalated", status: "failed" }),
			])
			expect(release).toHaveBeenCalledExactlyOnceWith("tc-1", "agent-1")
		})

		it("reports nothing for a request withdrawn by a mode change and asks again on the same card", async () => {
			const updates: Array<{ update: Record<string, unknown> }> = []
			const payloads: Array<{ toolCall: ToolCall }> = []
			let answer: (() => Promise<unknown>) | undefined
			const conn = {
				request: vi.fn(async (_method: string, payload: { toolCall: ToolCall }) => {
					payloads.push(payload)
					return answer ? answer() : new Promise(() => {})
				}),
				notify: vi.fn(async (_method: string, payload: { update: Record<string, unknown> }) => {
					updates.push(payload)
				}),
			} as unknown as AgentContext
			const ids = new Map<string, string>()
			const resolver = vi.fn((id: string, _tool: string, agentId?: string) => {
				const key = `${agentId}:${id}`
				if (!ids.has(key)) ids.set(key, `acp-${ids.size + 1}`)
				return ids.get(key) as string
			})
			const release = vi.fn((id: string, agentId: string) => ids.delete(`${agentId}:${id}`))
			const prompter = createAcpPermissionPrompter(conn, "sess-1", {} as never, resolver, undefined, release)

			const controller = new AbortController()
			const withdrawn = prompter.request({ ...originReq, signal: controller.signal })
			controller.abort(MODE_CHANGED_ABORT_ERROR)
			expect(await withdrawn).toEqual({ kind: "aborted" })
			// Nobody refused the call, and it has not run: no status at all.
			expect(statusUpdates(updates)).toHaveLength(0)
			expect(release).not.toHaveBeenCalled()

			// Decided again under the new mode: the same card is asked about.
			answer = async () => ({ outcome: { outcome: "selected", optionId: "choice-0" } })
			expect(await prompter.request(originReq)).toEqual({ kind: "allow-once" })
			expect(payloads.map((p) => p.toolCall.toolCallId)).toEqual(["acp-1", "acp-1"])

			report(prompter, "running")
			report(prompter, "completed")
			expect(statusUpdates(updates).map((u) => [u.toolCallId, u.status])).toEqual([
				["acp-1", "in_progress"],
				["acp-1", "completed"],
			])
		})

		it("closes a withdrawn card when the call then runs or is blocked without a new request", async () => {
			const { conn, updates } = makeRecordingConnection({ outcome: "selected", optionId: "choice-0" })
			vi.mocked(conn.request).mockImplementation(() => new Promise(() => {}))
			const prompter = createAcpPermissionPrompter(conn, "sess-1", {} as never, () => "acp-escalated")
			const controller = new AbortController()
			const withdrawn = prompter.request({ ...originReq, signal: controller.signal })
			controller.abort(MODE_CHANGED_ABORT_ERROR)
			await withdrawn

			// For example a switch to plan: the gate blocks the call itself.
			report(prompter, "failed")
			expect(statusUpdates(updates)).toEqual([
				expect.objectContaining({ toolCallId: "acp-escalated", status: "failed" }),
			])
		})

		it("sends one ending only", async () => {
			const { conn, updates } = makeRecordingConnection({ outcome: "selected", optionId: "choice-0" })
			const release = vi.fn()
			const prompter = createAcpPermissionPrompter(
				conn,
				"sess-1",
				{} as never,
				() => "acp-escalated",
				undefined,
				release,
			)
			await prompter.request(originReq)

			report(prompter, "completed")
			report(prompter, "failed")
			report(prompter, "running")
			expect(statusUpdates(updates).map((u) => u.status)).toEqual(["completed"])
			expect(release).toHaveBeenCalledOnce()
		})

		it("ignores a report for a call that never had a card", async () => {
			const { conn, updates } = makeRecordingConnection({ outcome: "selected", optionId: "choice-0" })
			const release = vi.fn()
			const prompter = createAcpPermissionPrompter(
				conn,
				"sess-1",
				{} as never,
				() => "acp-escalated",
				undefined,
				release,
			)
			const controller = new AbortController()
			controller.abort(MODE_CHANGED_ABORT_ERROR)

			// Aborted before it was sent: the client has nothing to update.
			expect(await prompter.request({ ...originReq, signal: controller.signal })).toEqual({ kind: "aborted" })
			expect(conn.request).not.toHaveBeenCalled()
			report(prompter, "running")
			report(prompter, "failed")
			expect(statusUpdates(updates)).toHaveLength(0)
			expect(release).not.toHaveBeenCalled()
		})

		it("keeps the cards of two subagents with the same call id apart", async () => {
			const { conn, updates } = makeRecordingConnection({ outcome: "selected", optionId: "choice-0" })
			const resolver = (_id: string, _tool: string, agentId?: string) => `acp-${agentId}`
			const prompter = createAcpPermissionPrompter(conn, "sess-1", {} as never, resolver)
			await prompter.request(originReq)
			await prompter.request({ ...originReq, origin: { ...originReq.origin, agentId: "agent-2" } })

			report(prompter, "failed", "agent-2")
			report(prompter, "completed", "agent-1")
			expect(statusUpdates(updates).map((u) => [u.toolCallId, u.status])).toEqual([
				["acp-agent-2", "failed"],
				["acp-agent-1", "completed"],
			])
		})

		it("does not let a failed update escape, and still releases the id", async () => {
			const { conn } = makeRecordingConnection({ outcome: "selected", optionId: "choice-0" })
			vi.mocked(conn.notify).mockRejectedValue(new Error("client disconnected"))
			const release = vi.fn()
			const prompter = createAcpPermissionPrompter(
				conn,
				"sess-1",
				{} as never,
				() => "acp-escalated",
				undefined,
				release,
			)
			expect(await prompter.request(originReq)).toEqual({ kind: "allow-once" })

			expect(() => report(prompter, "completed")).not.toThrow()
			await Promise.resolve()
			expect(release).toHaveBeenCalledWith("tc-1", "agent-1")
		})
	})
})
