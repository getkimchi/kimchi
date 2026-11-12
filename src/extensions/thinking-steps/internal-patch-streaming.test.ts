/** biome-ignore-all lint/suspicious/noExplicitAny: accessing private props */

/**
 * Streaming behavior of the thinking-steps patch: while a message's thinking
 * is active, the message content is rebuilt on every message_update, so the
 * patch must render the cheap cached tail preview — never ThinkingStepsComponent,
 * whose constructor re-derives every step from the full accumulated text
 * (measured: main-thread saturation and multi-second input freezes on large
 * thinking). Settled messages memoize their derivation per message object.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai"
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { retainThinkingStepsPatch } from "./internal-patch.js"
import { resetDerivedStepsMemoForTests } from "./parse.js"
import { ThinkingStepsComponent } from "./render.js"
import {
	clearActiveThinkingState,
	resetThinkingStepsViewState,
	setActiveThinkingState,
	setThinkingStepsMode,
} from "./state.js"

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
}

function makeMessage(content: unknown, timestamp = 1000): AssistantMessage {
	return { role: "assistant", timestamp, content } as AssistantMessage
}

const THINKING_ONLY = makeMessage([
	{ type: "thinking", thinking: "I should inspect the config first.", redacted: false },
])

function renderedChildren(message: AssistantMessage, hideThinkingBlock: boolean): any[] {
	const component = new AssistantMessageComponent(undefined as any)
	;(component as any).hideThinkingBlock = hideThinkingBlock
	component.updateContent(message)
	return (component as any).contentContainer.children
}

const isThinkingSteps = (child: any) => child instanceof ThinkingStepsComponent
const isLivePreview = (child: any) => child.constructor.name === "LiveThinkingPreview"

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
	resetDerivedStepsMemoForTests()
	setThinkingStepsMode("expanded")
})

describe("streaming thinking renders the tail preview", () => {
	it("does not construct ThinkingStepsComponent while thinking is active", () => {
		setActiveThinkingState({ active: true, messageTimestamp: 1000 })
		const children = renderedChildren(THINKING_ONLY, false)
		expect(children.some(isThinkingSteps)).toBe(false)
		expect(children.some(isLivePreview)).toBe(true)
	})

	it("constructs the full view once the message settles", () => {
		const children = renderedChildren(THINKING_ONLY, false)
		expect(children.some(isThinkingSteps)).toBe(true)
		expect(children.some(isLivePreview)).toBe(false)
	})

	it("swaps the tail preview for the full view when the same instance settles", () => {
		setActiveThinkingState({ active: true, messageTimestamp: 1000 })
		const component = new AssistantMessageComponent(undefined as any)
		;(component as any).hideThinkingBlock = false
		component.updateContent(THINKING_ONLY)
		const children = () => (component as any).contentContainer.children as any[]
		expect(children().some(isThinkingSteps)).toBe(false)
		expect(children().some(isLivePreview)).toBe(true)
		clearActiveThinkingState(1000)
		component.updateContent(THINKING_ONLY)
		expect(children().some(isLivePreview)).toBe(false)
		expect(children().some(isThinkingSteps)).toBe(true)
	})

	it("settles at render time when the run ends without a further updateContent", () => {
		// A loop-level exception mid-thinking orphans the streaming message:
		// handleRunFailure emits events for a NEW failure message, agent_end
		// clears the active state, and nothing re-runs updateContent here. The
		// preview must stop pulsing on its next paint.
		setActiveThinkingState({ active: true, messageTimestamp: 1000 })
		const component = new AssistantMessageComponent(undefined as any)
		;(component as any).hideThinkingBlock = false
		component.updateContent(THINKING_ONLY)
		const preview = ((component as any).contentContainer.children as any[]).find(isLivePreview)
		expect(preview).toBeDefined()
		expect(preview.render(80).join("\n")).toMatch(/Thinking [·•]/)
		clearActiveThinkingState(undefined)
		const settled = preview.render(80).join("\n")
		expect(settled).toContain("Thinking")
		expect(settled).not.toMatch(/Thinking [·•]/)
	})

	it("still renders the tail preview while active when thinking is hidden", () => {
		setActiveThinkingState({ active: true, messageTimestamp: 1000 })
		const children = renderedChildren(THINKING_ONLY, true)
		expect(children.some(isThinkingSteps)).toBe(false)
		expect(children.some(isLivePreview)).toBe(true)
	})
})

describe("per-message derivation memo", () => {
	it("reuses the derived steps across renders of the same message", () => {
		const first = renderedChildren(THINKING_ONLY, false).find(isThinkingSteps)
		const second = renderedChildren(THINKING_ONLY, false).find(isThinkingSteps)
		expect(first).toBeDefined()
		expect((first as any).steps).toBe((second as any).steps)
	})

	it("reuses the derivation across streaming spreads of the same message", () => {
		// The agent loop emits every message_update as `message: { ...partialMessage }`:
		// a fresh object per delta sharing the accumulating message's content array.
		const first = renderedChildren(THINKING_ONLY, false).find(isThinkingSteps)
		const spread = { ...THINKING_ONLY }
		const second = renderedChildren(spread, false).find(isThinkingSteps)
		expect((second as any).steps).toBe((first as any).steps)
	})

	it("re-derives when the shared content's thinking grows in place", () => {
		const message = makeMessage([{ type: "thinking", thinking: "short reasoning", redacted: false }])
		const before = renderedChildren(message, false).find(isThinkingSteps)
		;(message.content[0] as any).thinking = "much longer reasoning text that changes the signature entirely"
		const after = renderedChildren({ ...message }, false).find(isThinkingSteps)
		expect((after as any).steps).not.toBe((before as any).steps)
	})

	it("does not share derivations between different messages with equal thinking", () => {
		const other = makeMessage([{ type: "thinking", thinking: "I should inspect the config first.", redacted: false }])
		const first = renderedChildren(THINKING_ONLY, false).find(isThinkingSteps)
		const second = renderedChildren(other, false).find(isThinkingSteps)
		expect((first as any).steps).not.toBe((second as any).steps)
	})
})

describe("hidden settled thinking", () => {
	it("renders the collapsed marker instead of the steps view or preview", () => {
		const children = renderedChildren(THINKING_ONLY, true)
		expect(children.some(isThinkingSteps)).toBe(false)
		expect(children.some(isLivePreview)).toBe(false)
		const text = children
			.map((child) => (typeof child.render === "function" ? child.render(80).join("\n") : ""))
			.join("\n")
		expect(text).toMatch(/Thought for|Thinking\.\.\./)
	})
})
