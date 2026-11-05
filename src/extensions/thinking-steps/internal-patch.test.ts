/** biome-ignore-all lint/suspicious/noExplicitAny: accessing private props */

/**
 * The thinking-steps runtime patch replaces AssistantMessageComponent's
 * updateContent — the patched renderer must keep forwarding extension
 * markdown transformers to assistant text blocks (upstream semantics:
 * createMarkdownTransform("assistant", isStreaming, transformers) —
 * sequential application, string result wins, throwing/non-string
 * transformers keep the current markdown). The pii-redaction token
 * substitution rides this seam; an upstream rename of the mirrored
 * internals would regress it silently without these tests.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai"
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { testTheme } from "../__mocks__/theme.js"
import { retainThinkingStepsPatch } from "./internal-patch.js"
import { resetThinkingStepsViewState } from "./state.js"

// Real kimchi theme styling wraps runs in SGR codes; strip them for text asserts.
const ANSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g")
const stripAnsi = (s: string) => s.replace(ANSI_RE, "")

function makeMessage(content: unknown): AssistantMessage {
	return { role: "assistant", timestamp: 1000, content } as AssistantMessage
}

const TEXT_MESSAGE = makeMessage([{ type: "text", text: "answer with [EMAIL_ADDRESS_1] inside" }])

function patchedComponent(transformers: Array<(text: string, ctx?: unknown) => string | undefined>) {
	const component = new AssistantMessageComponent(undefined as any)
	;(component as any).markdownTransformers = transformers
	return component
}

function renderJoined(component: any, message: AssistantMessage, isStreaming?: boolean): string {
	component.updateContent(message, isStreaming)
	const children = (component as any).contentContainer.children.filter((c: any) => c?.options?.transform)
	expect(children.length).toBeGreaterThan(0)
	return stripAnsi(children.map((child: any) => child.render(120).join("\n")).join("\n"))
}

let releasePatch: () => Promise<void>

beforeAll(async () => {
	initTheme("default")
	releasePatch = await retainThinkingStepsPatch(testTheme)
})

afterAll(async () => {
	await releasePatch()
})

beforeEach(() => {
	resetThinkingStepsViewState()
})

describe("patched renderer markdown-transformer forwarding", () => {
	it("invokes every transformer with the upstream context shape", () => {
		const seen: Array<{ messageType?: string; isStreaming?: boolean; availableWidth?: number }> = []
		const component = patchedComponent([
			(_text, ctx: any) => {
				seen.push(ctx)
				return undefined
			},
		])
		renderJoined(component, TEXT_MESSAGE)
		expect(seen.length).toBeGreaterThan(0)
		for (const ctx of seen) {
			expect(ctx.messageType).toBe("assistant")
			expect(typeof ctx.availableWidth).toBe("number")
		}
	})

	it("applies a string-returning transformer to the visible output", () => {
		const component = patchedComponent([(text) => text.replace("[EMAIL_ADDRESS_1]", "alice@corp-mail.io")])
		const out = renderJoined(component, TEXT_MESSAGE)
		expect(out).toContain("alice@corp-mail.io")
		expect(out).not.toContain("[EMAIL_ADDRESS_1]")
	})

	it("keeps the current markdown when a transformer throws or returns non-string", () => {
		const component = patchedComponent([
			(text) => text.replace("inside", "swapped"),
			() => {
				throw new Error("boom")
			},
			() => undefined,
		])
		const out = renderJoined(component, TEXT_MESSAGE)
		expect(out).toContain("swapped")
		expect(out).not.toContain("inside")
	})

	it("mirrors the isStreaming argument into the transformer context", () => {
		const flags: boolean[] = []
		const component = patchedComponent([
			(_text, ctx: any) => {
				flags.push(ctx.isStreaming)
				return undefined
			},
		])
		renderJoined(component, TEXT_MESSAGE, true)
		renderJoined(component, TEXT_MESSAGE, false)
		expect(flags).toContain(true)
		expect(flags).toContain(false)
	})
})
