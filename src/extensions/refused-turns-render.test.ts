/** biome-ignore-all lint/suspicious/noExplicitAny: constructing an upstream component without a message */

/**
 * The TUI carve-out for refused turns, layered as at startup: cli.ts installs
 * applyRefusalNoticeRenderingPatch, then thinking-steps may replace
 * updateContent at session_start. Either way the notice prints as plain
 * warning-colored text, so the backticked checks stay literal instead of
 * turning into markdown inline code. Kept apart from refused-turns.test.ts
 * because both patches mutate the shared AssistantMessageComponent prototype.
 */

import { stripVTControlCharacters } from "node:util"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { testTheme } from "./__mocks__/theme.js"
import { applyRefusalNoticeRenderingPatch, isRefusalNotice, refusalNotice } from "./refused-turns.js"
import { retainThinkingStepsPatch } from "./thinking-steps/internal-patch.js"

const PI_THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme")
const DETECTED_ISSUE = "Detected issue: `injection_intent`, `offensive_intent`"

// What refused-turns writes on message_end, with checks from two guardrails
// (an injected tool result that also asked for offensive work).
const REFUSED = {
	role: "assistant",
	timestamp: 1000,
	content: [{ type: "text", text: refusalNotice({ flaggedChecks: ["injection_intent", "offensive_intent"] }) }],
	stopReason: "stop",
	errorMessage: "kimchi:refusal",
} as unknown as AssistantMessage

function render(message: AssistantMessage): string {
	const component = new AssistantMessageComponent(undefined as any)
	component.updateContent(message)
	return component.render(200).join("\n")
}

const globals = globalThis as Record<symbol, unknown>
let previousTheme: unknown

beforeAll(() => {
	initTheme("default")
	previousTheme = globals[PI_THEME_KEY]
	globals[PI_THEME_KEY] = testTheme
	applyRefusalNoticeRenderingPatch()
})

afterAll(() => {
	globals[PI_THEME_KEY] = previousTheme
})

function expectPlainWarningNotice(rendered: string): void {
	expect(stripVTControlCharacters(rendered)).toContain("Sorry, I can't assist with this request")
	expect(stripVTControlCharacters(rendered)).toContain(DETECTED_ISSUE)
	expect(rendered).toContain(testTheme.fg("warning", DETECTED_ISSUE))
}

describe("refusal notice rendering", () => {
	it("fixture is the shape refused-turns writes", () => {
		expect(isRefusalNotice(REFUSED)).toBe(true)
	})

	it("prints the notice as plain warning-colored text, checks literal", () => {
		expectPlainWarningNotice(render(REFUSED))
	})
})

describe("refusal notice rendering under thinking-steps", () => {
	let releasePatch: () => Promise<void>

	beforeAll(async () => {
		releasePatch = await retainThinkingStepsPatch(testTheme)
	})

	afterAll(async () => {
		await releasePatch()
	})

	it("still prints the notice as plain warning-colored text, checks literal", () => {
		expectPlainWarningNotice(render(REFUSED))
	})

	it("control: ordinary replies still render as markdown", () => {
		const reply = { ...REFUSED, errorMessage: undefined } as unknown as AssistantMessage

		const text = stripVTControlCharacters(render(reply))

		expect(text).toContain("Detected issue: injection_intent, offensive_intent")
		expect(text).not.toContain("`injection_intent`")
	})
})
