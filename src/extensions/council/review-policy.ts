import type { Context, ToolCall } from "@earendil-works/pi-ai"
import { classifyBashCommand } from "../bash-tool-guard.js"

const MUTATING_TOOLS = new Set(["edit", "write"])

export function isMutatingCouncilToolCall(toolName: string, args: unknown): boolean {
	if (MUTATING_TOOLS.has(toolName)) return true
	if (toolName !== "bash" || !args || typeof args !== "object" || !("command" in args)) return false
	const command = (args as { command?: unknown }).command
	if (typeof command !== "string") return false
	const category = classifyBashCommand(command)?.category
	return category === "edit" || category === "write"
}

function isMutatingToolCall(call: ToolCall): boolean {
	return isMutatingCouncilToolCall(call.name, call.arguments)
}

export function shouldReviewCouncilTurn(context: Context, policy: "always" | "changes"): boolean {
	if (policy === "always") return true
	let turnStart = 0
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index]
		if (message?.role === "assistant" && message.stopReason !== "toolUse") {
			turnStart = index + 1
			break
		}
	}
	return context.messages.slice(turnStart).some((message) => {
		if (message.role === "toolResult") return !message.isError && MUTATING_TOOLS.has(message.toolName)
		return (
			message.role === "assistant" &&
			message.content.some((block) => block.type === "toolCall" && isMutatingToolCall(block))
		)
	})
}
