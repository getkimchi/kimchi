import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Model,
	TextContent,
	ToolCall,
} from "@earendil-works/pi-ai"

export type CouncilProgressStage = "validating" | "drafting" | "reviewing" | "judging" | "revising" | "finalizing"

const PROGRESS_LABELS: Record<CouncilProgressStage, string> = {
	validating: "Council: validating models",
	drafting: "Council: drafting",
	reviewing: "Council: reviewing",
	judging: "Council: adjudicating",
	revising: "Council: revising",
	finalizing: "Council: finalizing",
}

export function councilProgressLabel(stage: CouncilProgressStage, completed?: number, total?: number): string {
	const count = completed !== undefined && total !== undefined ? ` ${completed}/${total}` : ""
	return `${PROGRESS_LABELS[stage]}${count}`
}

export function virtualizePublicMessage(
	message: AssistantMessage,
	virtualModel: Model<Api>,
	usage: AssistantMessage["usage"],
): AssistantMessage {
	return {
		...message,
		content: message.content.filter((block): block is TextContent | ToolCall => block.type !== "thinking"),
		api: virtualModel.api,
		provider: virtualModel.provider,
		model: virtualModel.id,
		usage,
		responseModel: undefined,
		responseId: undefined,
		diagnostics: undefined,
	}
}

export class CouncilStreamWriter {
	private ended = false

	constructor(private readonly stream: AssistantMessageEventStream) {}

	emit(message: AssistantMessage): boolean {
		if (this.ended) return false
		this.ended = true
		const partial: AssistantMessage = { ...message, content: [] }
		this.stream.push({ type: "start", partial })
		for (const [contentIndex, block] of message.content.entries()) {
			if (block.type === "text") {
				partial.content = [...partial.content, { type: "text", text: "" }]
				this.stream.push({ type: "text_start", contentIndex, partial: { ...partial } })
				partial.content[contentIndex] = block
				this.stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: { ...partial } })
				this.stream.push({ type: "text_end", contentIndex, content: block.text, partial: { ...partial } })
			} else if (block.type === "toolCall") {
				partial.content = [...partial.content, { ...block, arguments: {} }]
				this.stream.push({ type: "toolcall_start", contentIndex, partial: { ...partial } })
				this.stream.push({
					type: "toolcall_delta",
					contentIndex,
					delta: JSON.stringify(block.arguments),
					partial: { ...partial },
				})
				partial.content[contentIndex] = block
				this.stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: { ...partial } })
			}
		}
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			this.stream.push({ type: "error", reason: message.stopReason, error: message })
		} else {
			this.stream.push({ type: "done", reason: message.stopReason, message })
		}
		this.stream.end(message)
		return true
	}
}
