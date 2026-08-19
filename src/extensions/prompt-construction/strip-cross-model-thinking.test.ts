import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import type { OrchestratorMessages } from "../orchestration/continuation-nudge.js"
import { type ActiveModelRef, stripCrossModelThinking } from "./strip-cross-model-thinking.js"

const REPO_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)))

const ACTIVE_MODEL: ActiveModelRef = { provider: "kimchi-dev", api: "openai-completions", id: "kimi-k2.7" }

function makeUser(text: string): OrchestratorMessages[number] {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() }
}

function makeAssistant(
	origin: { provider: string; api: string; model: string },
	content: AssistantMessage["content"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: origin.api,
		provider: origin.provider,
		model: origin.model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	}
}

const GLM = { provider: "kimchi-dev", api: "openai-completions", model: "glm-5.2-fp8" }
const KIMI = { provider: "kimchi-dev", api: "openai-completions", model: "kimi-k2.7" }
const ANTHROPIC = { provider: "anthropic", api: "anthropic-messages", model: "claude-sonnet-4" }

describe("stripCrossModelThinking", () => {
	it("removes cross-model thinking blocks but keeps text and tool calls", () => {
		const messages: OrchestratorMessages = [
			makeUser("continue"),
			makeAssistant(GLM, [
				{ type: "thinking", thinking: "I should read the detail page..." },
				{ type: "text", text: "getFullProviderDisplayName is used in two places." },
				{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
			]),
		]

		const result = stripCrossModelThinking(messages, ACTIVE_MODEL)

		expect(result).not.toBe(messages)
		const assistant = result[1] as AssistantMessage
		expect(assistant.content).toEqual([
			{ type: "text", text: "getFullProviderDisplayName is used in two places." },
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
		])
	})

	it("preserves same-model thinking blocks verbatim", () => {
		const thinking = { type: "thinking", thinking: "my own reasoning", thinkingSignature: "sig" } as const
		const messages: OrchestratorMessages = [makeAssistant(KIMI, [thinking, { type: "text", text: "done" }])]

		const result = stripCrossModelThinking(messages, ACTIVE_MODEL)

		expect(result).toBe(messages)
		expect((result[0] as AssistantMessage).content[0]).toEqual(thinking)
	})

	it("keeps a cross-model thinking-only message with empty content (pi-ai skips it downstream)", () => {
		const messages: OrchestratorMessages = [
			makeUser("go"),
			makeAssistant(GLM, [{ type: "thinking", thinking: "internal plan only" }]),
		]

		const result = stripCrossModelThinking(messages, ACTIVE_MODEL)

		expect(result).toHaveLength(2)
		expect((result[1] as AssistantMessage).content).toEqual([])
	})

	it("removes redacted cross-model thinking blocks", () => {
		const messages: OrchestratorMessages = [
			makeAssistant(ANTHROPIC, [
				{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "opaque" },
				{ type: "text", text: "answer" },
			]),
		]

		const result = stripCrossModelThinking(messages, { provider: "openai", api: "openai-completions", id: "gpt-5" })

		expect((result[0] as AssistantMessage).content).toEqual([{ type: "text", text: "answer" }])
	})

	it("in a mixed history strips only mismatched blocks and keeps same-model thinking", () => {
		const messages: OrchestratorMessages = [
			makeAssistant(GLM, [
				{ type: "thinking", thinking: "glm plan" },
				{ type: "text", text: "glm text" },
			]),
			makeAssistant(KIMI, [
				{ type: "thinking", thinking: "kimi plan" },
				{ type: "text", text: "kimi text" },
			]),
			makeUser("continue"),
		]

		const result = stripCrossModelThinking(messages, ACTIVE_MODEL)

		expect((result[0] as AssistantMessage).content).toEqual([{ type: "text", text: "glm text" }])
		expect((result[1] as AssistantMessage).content).toEqual([
			{ type: "thinking", thinking: "kimi plan" },
			{ type: "text", text: "kimi text" },
		])
		expect(result[2]).toBe(messages[2])
	})

	it("returns the same array reference when there is no cross-model thinking", () => {
		const messages: OrchestratorMessages = [
			makeUser("hi"),
			makeAssistant(KIMI, [{ type: "text", text: "Done." }]),
			makeAssistant(GLM, [{ type: "text", text: "cross-model text without thinking stays" }]),
		]

		expect(stripCrossModelThinking(messages, ACTIVE_MODEL)).toBe(messages)
	})

	it("returns the same array reference when there is no active model", () => {
		const messages: OrchestratorMessages = [makeAssistant(GLM, [{ type: "thinking", thinking: "plan" }])]
		expect(stripCrossModelThinking(messages, undefined)).toBe(messages)
	})

	it("returns the same array reference for an empty message list", () => {
		const messages: OrchestratorMessages = []
		expect(stripCrossModelThinking(messages, ACTIVE_MODEL)).toBe(messages)
	})
})

describe("stripCrossModelThinking wiring contract", () => {
	it("every context handler in prompt-enrichment applies the strip", () => {
		const source = readFileSync(resolve(REPO_ROOT, "src/extensions/prompt-construction/prompt-enrichment.ts"), "utf8")
		// Handler bodies: text after each pi.on("context"... up to the next
		// pi.on(" registration. Any context handler added to this file must
		// consciously decide to apply the strip — hence the strict length assert.
		const bodies = source
			.split(/pi\.on\("context"[^\n]*\n/)
			.slice(1)
			.map((rest) => rest.split(/\n\s*pi\.on\("/)[0])
		expect(bodies.length).toBe(2)
		for (const body of bodies) {
			expect(body).toContain("stripCrossModelThinking(")
		}
	})
})
