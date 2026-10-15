/** biome-ignore-all lint/suspicious/noExplicitAny: accessing private props */

/**
 * "none" thinking view mode: thinking blocks render nothing — no live preview
 * while a turn is active, no collapsed marker once settled, no steps view.
 * Control cases pin the non-none renderers so the suppression assertions
 * cannot pass vacuously.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai"
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { retainThinkingStepsPatch } from "./internal-patch.js"
import { parseThinkingMode } from "./parse.js"
import { resetThinkingStepsViewState, setActiveThinkingState, setThinkingStepsMode } from "./state.js"

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
}

function makeMessage(content: unknown): AssistantMessage {
	return { role: "assistant", timestamp: 1000, content } as AssistantMessage
}

const THINKING_ONLY = makeMessage([
	{ type: "thinking", thinking: "I should inspect the config first.", redacted: false },
])
const TEXT_AND_THINKING = makeMessage([
	{ type: "thinking", thinking: "I should inspect the config first.", redacted: false },
	{ type: "text", text: "Here is the answer." },
])

function childrenCount(message: AssistantMessage, hideThinkingBlock: boolean): number {
	const component = new AssistantMessageComponent(undefined as any)
	;(component as any).hideThinkingBlock = hideThinkingBlock
	component.updateContent(message)
	return (component as any).contentContainer.children.length
}

let releasePatch: () => Promise<void>

beforeAll(async () => {
	initTheme("default")
	releasePatch = await retainThinkingStepsPatch(theme)
})

afterAll(async () => {
	await releasePatch()
})

beforeEach(() => {
	resetThinkingStepsViewState()
})

describe("parseThinkingMode none aliases", () => {
	it("accepts none and n", () => {
		expect(parseThinkingMode("none")).toBe("none")
		expect(parseThinkingMode(" n ")).toBe("none")
		expect(parseThinkingMode("n")).toBe("none")
	})

	it("still rejects unknown modes", () => {
		expect(parseThinkingMode("garbage")).toBeUndefined()
	})
})

describe("none thinking view mode", () => {
	it("renders nothing for settled thinking when thinking is hidden", () => {
		setThinkingStepsMode("none")
		expect(childrenCount(THINKING_ONLY, true)).toBe(0)
	})

	it("control: non-none modes render the collapsed marker", () => {
		setThinkingStepsMode("summary")
		expect(childrenCount(THINKING_ONLY, true)).toBeGreaterThan(0)
	})

	it("renders nothing for active thinking when thinking is hidden", () => {
		setThinkingStepsMode("none")
		setActiveThinkingState({ active: true, messageTimestamp: 1000 })
		expect(childrenCount(THINKING_ONLY, true)).toBe(0)
	})

	it("control: non-none modes render the live preview while active", () => {
		setThinkingStepsMode("summary")
		setActiveThinkingState({ active: true, messageTimestamp: 1000 })
		expect(childrenCount(THINKING_ONLY, true)).toBeGreaterThan(0)
	})

	it("renders nothing when the thinking steps view is enabled", () => {
		setThinkingStepsMode("none")
		expect(childrenCount(THINKING_ONLY, false)).toBe(0)
	})

	it("control: non-none modes render the thinking steps view", () => {
		setThinkingStepsMode("summary")
		expect(childrenCount(THINKING_ONLY, false)).toBeGreaterThan(0)
	})

	it("still renders the text content of a mixed message", () => {
		setThinkingStepsMode("none")
		// Spacer + Markdown only — no preview, no marker, no extra spacer.
		expect(childrenCount(TEXT_AND_THINKING, true)).toBe(2)
	})
})
