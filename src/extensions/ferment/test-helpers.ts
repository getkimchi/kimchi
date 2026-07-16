import type { Mock } from "vitest"

/**
 * Message shape sent via `pi.sendMessage` in ferment tests.
 */
export interface FermentSendMessage {
	customType?: string
	content?: Array<{ text?: string }>
	details?: { variant?: string; action?: string }
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
export function filterSentMessages(sendMessage: Mock, customType: string, variant?: string): FermentSendMessage[] {
	return sendMessage.mock.calls
		.map(([message]) => message as FermentSendMessage)
		.filter((message) => {
			if (message.customType !== customType) return false
			if (variant !== undefined && message.details?.variant !== variant) return false
			return true
		})
}
