import type { McpSettings } from "../../../../src/extensions/mcp-adapter/types.js"
import type { FakeResponseScript, RecordedRequest } from "./fake-openai-server.js"

type JsonObject = Record<string, unknown>

export interface ScriptedModelToolCall {
	id: string
	modelToolName: string
	response: FakeResponseScript
}

export interface ScriptedMcpToolCall extends ScriptedModelToolCall {
	serverName: string
	originalToolName: string
}

interface McpCallOptions {
	id?: string
	serverName?: string
	toolPrefix?: McpSettings["toolPrefix"]
}

let generatedCallId = 0

function nextCallId(label: string): string {
	generatedCallId += 1
	return `call_mcp_${label.replaceAll(/[^a-zA-Z0-9]+/g, "_")}_${generatedCallId}`
}

function prefixedToolName(serverName: string, toolName: string, prefix: McpCallOptions["toolPrefix"]): string {
	if (prefix === "none") return toolName
	let normalizedServerName = serverName.replaceAll("-", "_")
	if (prefix === "short") {
		normalizedServerName = serverName.replace(/-?mcp$/i, "").replaceAll("-", "_") || "mcp"
	}
	return `${normalizedServerName}_${toolName}`
}

function modelToolCall(name: string, args: JsonObject, id: string): FakeResponseScript {
	return {
		toolCalls: [
			{
				id,
				function: { name, arguments: JSON.stringify(args) },
			},
		],
	}
}

export function gatewayMcpCall(toolName: string, args?: JsonObject, options: McpCallOptions = {}): ScriptedMcpToolCall {
	const serverName = options.serverName ?? "fixture"
	const id = options.id ?? nextCallId(`gateway_${serverName}_${toolName}`)
	const gatewayArgs: JsonObject = {
		tool: prefixedToolName(serverName, toolName, options.toolPrefix),
		server: serverName,
		...(args === undefined ? {} : { args: JSON.stringify(args) }),
	}
	return {
		id,
		modelToolName: "mcp",
		serverName,
		originalToolName: toolName,
		response: modelToolCall("mcp", gatewayArgs, id),
	}
}

export function directMcpCall(toolName: string, args: JsonObject, options: McpCallOptions = {}): ScriptedMcpToolCall {
	const serverName = options.serverName ?? "fixture"
	const id = options.id ?? nextCallId(`direct_${serverName}_${toolName}`)
	const modelName = prefixedToolName(serverName, toolName, options.toolPrefix)
	return {
		id,
		modelToolName: modelName,
		serverName,
		originalToolName: toolName,
		response: modelToolCall(modelName, args, id),
	}
}

export function searchMcpTools(
	query: string,
	options: Pick<McpCallOptions, "id" | "serverName"> = {},
): ScriptedModelToolCall {
	const id = options.id ?? nextCallId("search")
	return {
		id,
		modelToolName: "mcp",
		response: modelToolCall(
			"mcp",
			{ search: query, ...(options.serverName === undefined ? {} : { server: options.serverName }) },
			id,
		),
	}
}

export function connectMcpServer(serverName: string, options: Pick<McpCallOptions, "id"> = {}): ScriptedModelToolCall {
	const id = options.id ?? nextCallId(`connect_${serverName}`)
	return { id, modelToolName: "mcp", response: modelToolCall("mcp", { connect: serverName }, id) }
}

export function emptyMcpCall(options: Pick<McpCallOptions, "id"> = {}): ScriptedModelToolCall {
	const id = options.id ?? nextCallId("status")
	return { id, modelToolName: "mcp", response: modelToolCall("mcp", {}, id) }
}

export function mcpUiMessages(options: Pick<McpCallOptions, "id"> = {}): ScriptedModelToolCall {
	const id = options.id ?? nextCallId("ui_messages")
	return { id, modelToolName: "mcp", response: modelToolCall("mcp", { action: "ui-messages" }, id) }
}

export function modelReply(text: string): FakeResponseScript {
	return { stream: [text] }
}

export function parallelModelToolCalls(...calls: ScriptedModelToolCall[]): FakeResponseScript {
	return {
		toolCalls: calls.map((call, index) => {
			const toolCall = call.response.toolCalls?.[0]
			if (!toolCall) throw new Error(`Scripted model call ${call.id} does not contain a tool call`)
			return { ...toolCall, index }
		}),
	}
}

function requestMessages(request: RecordedRequest): JsonObject[] {
	if (!request.body || typeof request.body !== "object") return []
	const messages = (request.body as JsonObject).messages
	if (!Array.isArray(messages)) return []
	return messages.filter((message): message is JsonObject => Boolean(message) && typeof message === "object")
}

export function requireToolResult(
	requests: readonly RecordedRequest[],
	call: Pick<ScriptedModelToolCall, "id"> | string,
): JsonObject {
	const toolCallId = typeof call === "string" ? call : call.id
	for (const request of requests) {
		const result = requestMessages(request).find(
			(message) => message.role === "tool" && message.tool_call_id === toolCallId,
		)
		if (result) return result
	}
	throw new Error(
		`No model request contained a tool result for ${toolCallId}. Recorded requests: ${JSON.stringify(requests)}`,
	)
}

export function toolResultText(
	requests: readonly RecordedRequest[],
	call: Pick<ScriptedModelToolCall, "id"> | string,
): string {
	const content = requireToolResult(requests, call).content
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return JSON.stringify(content)
	return content
		.map((block) => {
			if (block && typeof block === "object" && typeof (block as JsonObject).text === "string") {
				return (block as JsonObject).text
			}
			return JSON.stringify(block)
		})
		.join("\n")
}

export function requireRequestAdvertisingTool(requests: readonly RecordedRequest[], toolName: string): RecordedRequest {
	for (const request of requests) {
		if (!request.body || typeof request.body !== "object") continue
		const tools = (request.body as JsonObject).tools
		if (!Array.isArray(tools)) continue
		const advertised = tools.some((tool) => {
			if (!tool || typeof tool !== "object") return false
			const fn = (tool as JsonObject).function
			return Boolean(fn && typeof fn === "object" && (fn as JsonObject).name === toolName)
		})
		if (advertised) return request
	}
	throw new Error(`No model request advertised tool ${toolName}. Recorded requests: ${JSON.stringify(requests)}`)
}
