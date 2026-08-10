import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Model,
	TextContent,
	ToolCall,
} from "@earendil-works/pi-ai"

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
	private partial?: AssistantMessage
	private liveTextIndex?: number
	private liveText = ""

	constructor(private readonly stream: AssistantMessageEventStream) {}

	emitTextDelta(message: AssistantMessage, delta: string): boolean {
		if (this.ended || delta.length === 0) return false
		this.ensureStarted(message)
		const partial = this.partial
		if (!partial) return false
		if (this.liveTextIndex === undefined) {
			this.liveTextIndex = partial.content.length
			partial.content = [...partial.content, { type: "text", text: "" }]
			this.stream.push({ type: "text_start", contentIndex: this.liveTextIndex, partial: { ...partial } })
		}
		this.liveText += delta
		partial.content[this.liveTextIndex] = { type: "text", text: this.liveText }
		this.stream.push({
			type: "text_delta",
			contentIndex: this.liveTextIndex,
			delta,
			partial: { ...partial },
		})
		return true
	}

	emit(message: AssistantMessage): boolean {
		if (this.ended) return false
		this.ended = true
		const partial = this.ensureStarted(message)
		if (this.liveTextIndex !== undefined) {
			partial.content[this.liveTextIndex] = { type: "text", text: this.liveText }
			this.stream.push({
				type: "text_end",
				contentIndex: this.liveTextIndex,
				content: this.liveText,
				partial: { ...partial },
			})
			let contentIndex = this.liveTextIndex + 1
			for (const block of message.content) {
				if (block.type !== "toolCall") continue
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
				contentIndex++
			}
		} else {
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
		}
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			this.stream.push({ type: "error", reason: message.stopReason, error: message })
		} else {
			this.stream.push({ type: "done", reason: message.stopReason, message })
		}
		this.stream.end(message)
		return true
	}

	private ensureStarted(message: AssistantMessage): AssistantMessage {
		if (!this.partial) {
			this.partial = { ...message, content: [] }
			this.stream.push({ type: "start", partial: this.partial })
		}
		return this.partial
	}
}
