import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import {
	type AgentMessageInput,
	AgentMessageInputSchema,
	type AgentMessageReceipt,
	validateAgentMessageInput,
} from "./messages.js"
import { textResult } from "./tool-result.js"

export const LIST_AGENT_CONTACTS_TOOL_NAME = "list_agent_contacts"
export const SEND_AGENT_MESSAGE_TOOL_NAME = "send_agent_message"

export interface AgentContact {
	agent_id?: string
	task_id?: string
	persona?: string
	description?: string
	status?: string
	reachable: boolean
	route?: "parent" | "questionnaire" | "ferment_judge" | "unavailable"
	ferment_id?: string
	reason?: string
}

export interface AgentContactList {
	parent: AgentContact
	user_via_parent: AgentContact
	peers: AgentContact[]
}

export interface AgentMessageCapability {
	listContacts(): AgentContactList
	sendMessage(toolCallId: string, input: AgentMessageInput): Promise<AgentMessageReceipt>
}

export function createAgentMessageExtension(capability: AgentMessageCapability): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.registerTool(
			defineTool({
				name: LIST_AGENT_CONTACTS_TOOL_NAME,
				label: "List Agent Contacts",
				description:
					"List recipients the host currently authorizes for this agent. Call again if peer state may have changed.",
				parameters: Type.Object({}, { additionalProperties: false }),
				execute: async () => textResult(JSON.stringify(capability.listContacts())),
			}),
		)

		pi.registerTool(
			defineTool({
				name: SEND_AGENT_MESSAGE_TOOL_NAME,
				label: "Send Agent Message",
				description:
					"Send one focused message to an authorized contact. A receipt proves only host queue acceptance or a completed bounded resume attempt; it does not prove delivery or recipient action.",
				parameters: AgentMessageInputSchema,
				execute: async (toolCallId, params) => {
					const validated = validateAgentMessageInput(params)
					if (!validated.valid) return textResult(validated.reason)
					const receipt = await capability.sendMessage(toolCallId, validated.value)
					return textResult(JSON.stringify(receipt))
				},
			}),
		)
	}
}
