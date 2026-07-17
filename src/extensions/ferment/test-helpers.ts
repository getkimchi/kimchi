import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { MockedFunction } from "vitest"

type SendMessage = ExtensionAPI["sendMessage"]
type SentMessage = Parameters<SendMessage>[0]
type SentMessageContent = Exclude<SentMessage["content"], string>
type SentTextContent = Extract<SentMessageContent[number], { type: "text" }>

interface FermentMessageDetails {
	variant?: string
	action?: string
}

/**
 * Message shape sent via `pi.sendMessage` in ferment tests.
 */
export type FermentSendMessage = Omit<SentMessage, "content" | "details"> & {
	content: SentTextContent[]
	details?: FermentMessageDetails
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string"
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

function isFermentSendMessage(message: SentMessage): message is FermentSendMessage {
	if (
		!Array.isArray(message.content) ||
		!message.content.every((part) => part.type === "text" && typeof part.text === "string")
	) {
		return false
	}
	if (message.details === undefined) return true
	if (!isRecord(message.details)) return false
	const { variant, action } = message.details
	return isOptionalString(variant) && isOptionalString(action)
}

/**
 * Filter `pi.sendMessage` mock calls by `customType`, optionally by
 * `details.variant`. Returns the message objects (not the raw call arrays)
 * since every call site only ever needs the message.
 *
 * @example
 * // filter by customType only
 * const calls = filterSentMessages(vi.mocked(pi.sendMessage), "ferment_continuation_nudge")
 *
 * // filter by customType + details.variant
 * const warnings = filterSentMessages(vi.mocked(pi.sendMessage), "ferment_breadcrumb", "warning")
 */
export function filterSentMessages(
	sendMessage: MockedFunction<SendMessage>,
	customType: string,
	variant?: string,
): FermentSendMessage[] {
	return sendMessage.mock.calls
		.map(([message]) => message)
		.filter(isFermentSendMessage)
		.filter((message) => {
			if (message.customType !== customType) return false
			if (variant !== undefined && message.details?.variant !== variant) return false
			return true
		})
}
