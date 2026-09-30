import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/**
 * Grammar of a valid tool name, per the OpenAI function-calling spec
 * (`^[a-zA-Z0-9_-]{1,64}$`). The harness registers slugs like `Agent`,
 * `bash`, `todo_write` — all within this grammar.
 */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

interface MalformedToolCall {
	/** Set when a plausible tool name could be recovered from the garbage. */
	probableTool?: string
}

/**
 * Any reported tool name violating the spec grammar means the model emitted a
 * malformed call: arguments serialized into the function name instead of
 * structured arguments. Observed on glm-5.3-flash / openai-completions
 * (2026-09-30: a 3 KB `Agent description="…" prompt=…` string arrived as the
 * name with empty arguments), but the check is model-agnostic — whitespace,
 * punctuation, or an over-length name all violate the same contract.
 *
 * In that case the "not available in the tool list" guidance would be
 * misleading: the call is malformed, and (usually) the intended tool actually
 * IS available. When the first whitespace-delimited token is itself a valid
 * tool name (e.g. `Agent description="…"`), it is the almost-certain intended
 * callee and is returned as `probableTool`.
 */
function detectMalformedToolCall(toolName: string): MalformedToolCall | undefined {
	if (TOOL_NAME_PATTERN.test(toolName)) return undefined
	const firstToken = toolName.split(/\s+/)[0]
	if (firstToken && TOOL_NAME_PATTERN.test(firstToken)) return { probableTool: firstToken }
	return {}
}

const MAX_ECHOED_NAME_LENGTH = 120

function truncate(text: string): string {
	return text.length <= MAX_ECHOED_NAME_LENGTH ? text : `${text.slice(0, MAX_ECHOED_NAME_LENGTH)}…`
}

export default function hiddenToolGuidanceExtension(pi: ExtensionAPI): void {
	pi.on("message_end", (event) => {
		const message = event.message
		if (message.role !== "toolResult" || !message.isError) return

		const block = message.content.length === 1 ? message.content[0] : undefined
		if (block?.type !== "text" || block.text.trim() !== `Tool ${message.toolName} not found`) {
			return
		}

		const malformed = detectMalformedToolCall(message.toolName)
		if (malformed) {
			const echoedName = truncate(message.toolName)
			const text = malformed.probableTool
				? `Tool call rejected: the model serialized arguments into the function name ("${echoedName}") instead of emitting structured arguments. The intended tool is likely "${malformed.probableTool}" and it may be available — re-emit the tool call with name "${malformed.probableTool}" and proper JSON arguments.`
				: `Tool call rejected: the function name ("${echoedName}") is not a valid tool name, so the call was malformed rather than a request for a missing tool. Check the available tool list and re-emit the intended call with a valid name and structured arguments.`
			return {
				message: {
					...message,
					content: [
						{
							...block,
							text,
						},
					],
				},
			}
		}

		const toolName = truncate(message.toolName)
		return {
			message: {
				...message,
				content: [
					{
						...block,
						text: `Tool ${toolName} not found: "${toolName}" is not available in the current tool list. Continue with an available tool and retry only if "${toolName}" appears there later.`,
					},
				],
			},
		}
	})
}
