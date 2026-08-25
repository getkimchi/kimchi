import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import {
	type AgentMessageCapability,
	createAgentMessageExtension,
	LIST_AGENT_CONTACTS_TOOL_NAME,
	SEND_AGENT_MESSAGE_TOOL_NAME,
} from "./message-tool.js"

function makePi() {
	const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = []
	return {
		pi: { registerTool: vi.fn((tool) => tools.push(tool)) } as unknown as ExtensionAPI,
		tools,
	}
}

describe("agent communication child tools", () => {
	it("binds contact listing to the host capability", async () => {
		const capability: AgentMessageCapability = {
			listContacts: vi.fn(() => ({
				parent: { reachable: true },
				user_via_parent: { reachable: false, route: "unavailable" as const },
				peers: [],
			})),
			sendMessage: vi.fn(),
		}
		const { pi, tools } = makePi()
		createAgentMessageExtension(capability)(pi)

		expect(tools.map((tool) => tool.name)).toEqual([LIST_AGENT_CONTACTS_TOOL_NAME, SEND_AGENT_MESSAGE_TOOL_NAME])
		await expect(tools[0]?.execute("tool-call")).resolves.toMatchObject({
			content: [{ type: "text", text: expect.stringContaining('"reachable":true') }],
		})
		expect(capability.listContacts).toHaveBeenCalledOnce()
	})

	it("validates input before invoking the host send callback", async () => {
		const sendMessage = vi.fn().mockResolvedValue({ status: "queued_for_parent" })
		const capability: AgentMessageCapability = {
			listContacts: () => ({
				parent: { reachable: true },
				user_via_parent: { reachable: false, route: "unavailable" as const },
				peers: [],
			}),
			sendMessage,
		}
		const { pi, tools } = makePi()
		createAgentMessageExtension(capability)(pi)

		const result = await tools[1]?.execute("tool-call", {
			recipient: { type: "user" },
			payload: { kind: "status", summary: "not allowed for user" },
		})

		expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Message must use") }] })
		expect(sendMessage).not.toHaveBeenCalled()
	})

	it("returns the host receipt without claiming delivery", async () => {
		const sendMessage = vi.fn().mockResolvedValue({ status: "queued_for_parent", messageId: "m1", threadId: "m1" })
		const capability: AgentMessageCapability = {
			listContacts: () => ({
				parent: { reachable: true },
				user_via_parent: { reachable: false, route: "unavailable" as const },
				peers: [],
			}),
			sendMessage,
		}
		const { pi, tools } = makePi()
		createAgentMessageExtension(capability)(pi)

		const result = await tools[1]?.execute("tool-call", {
			recipient: { type: "parent" },
			payload: { kind: "status", summary: "progress" },
		})

		expect(sendMessage).toHaveBeenCalledWith("tool-call", expect.objectContaining({ recipient: { type: "parent" } }))
		expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("queued_for_parent") }] })
	})
})
