import { describe, expect, it } from "vitest"
import type { OrchestratorMessages } from "../orchestration/continuation-nudge.js"
import { isHarnessSteer } from "../steer-marker.js"
import { applyLanguageHint } from "./language-hint.js"
import { LANGUAGE_HINT_CUSTOM_TYPE } from "./system-prompt.js"

type Message = OrchestratorMessages[number]

function user(text: string, timestamp = 1): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp } as Message
}

function assistant(text: string): Message {
	return { role: "assistant", content: [{ type: "text", text }], timestamp: 2 } as unknown as Message
}

function toolResult(): Message {
	return {
		role: "toolResult",
		toolCallId: "t1",
		toolName: "read",
		content: [],
		isError: false,
		timestamp: 3,
	} as Message
}

function hint(language: string): Message {
	return {
		role: "custom",
		customType: LANGUAGE_HINT_CUSTOM_TYPE,
		content: [{ type: "text", text: `Reply in ${language}.` }],
		display: false,
		timestamp: 1,
	} as unknown as Message
}

function textOf(m: Message): string {
	const content = (m as { content: { text?: string }[] | string }).content
	return typeof content === "string" ? content : (content[0]?.text ?? "")
}

function hintsIn(messages: OrchestratorMessages): Message[] {
	return messages.filter(
		(m) => m.role === "custom" && (m as { customType?: string }).customType === LANGUAGE_HINT_CUSTOM_TYPE,
	)
}

describe("applyLanguageHint", () => {
	it("returns the same array when nothing is pinned and nothing to strip", () => {
		const messages = [user("bonjour"), assistant("salut")]
		expect(applyLanguageHint(messages, undefined)).toBe(messages)
	})

	it("inserts exactly one marked hint right after the latest user message", () => {
		const messages = [user("hi"), assistant("hello"), user("et maintenant ?", 5), toolResult()]
		const result = applyLanguageHint(messages, "English")

		expect(result).toHaveLength(5)
		expect(result[2]).toBe(messages[2])
		const h = result[3]
		expect(h.role).toBe("custom")
		expect((h as { customType?: string }).customType).toBe(LANGUAGE_HINT_CUSTOM_TYPE)
		expect((h as { display?: boolean }).display).toBe(false)
		expect(isHarnessSteer(textOf(h))).toBe(true)
		expect(textOf(h)).toContain("Reply in English.")
		// Tool loop continues after the hint; nothing else moved.
		expect(result[4]).toBe(messages[3])
		expect(hintsIn(result)).toHaveLength(1)
	})

	it("is stable across requests of the same turn (same position, same text)", () => {
		const turn = [user("hi"), assistant("hello"), user("again", 5)]
		const first = applyLanguageHint(turn, "ko")
		const second = applyLanguageHint([...turn, toolResult()], "ko")
		expect(textOf(first[3])).toBe(textOf(second[3]))
		expect(first.indexOf(first[3])).toBe(second.indexOf(second[3]))
	})

	it("strips hints persisted by older builds, then injects the current pin only", () => {
		const messages = [user("hi"), hint("ko"), assistant("안녕"), user("switch", 5), hint("ko")]
		const result = applyLanguageHint(messages, "fr")

		const hints = hintsIn(result)
		expect(hints).toHaveLength(1)
		expect(textOf(hints[0])).toContain("Reply in fr.")
		expect(textOf(hints[0])).not.toContain("Reply in ko")
		expect(result.indexOf(hints[0])).toBe(result.indexOf(messages[3]) + 1)
	})

	it("strips persisted hints when the pin is removed", () => {
		const messages = [user("hi"), hint("ko"), assistant("안녕"), user("now auto", 5), hint("ko")]
		const result = applyLanguageHint(messages, undefined)
		expect(hintsIn(result)).toHaveLength(0)
		expect(result).toEqual([messages[0], messages[2], messages[3]])
	})

	it("adds nothing when there is no user message to anchor to", () => {
		const messages = [assistant("hello")]
		expect(applyLanguageHint(messages, "ko")).toEqual(messages)
	})
})
