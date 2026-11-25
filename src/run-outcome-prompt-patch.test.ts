import type { AgentSession, PromptOptions } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { observeAgentSessionPrompts } from "./run-outcome-prompt-patch.js"

type PromptPrototype = Pick<AgentSession, "prompt">

describe("observeAgentSessionPrompts", () => {
	it("calls onPrompt before the original prompt runs", async () => {
		let calls = 0
		let callsAtOriginalEntry = -1
		const proto: PromptPrototype = {
			async prompt() {
				callsAtOriginalEntry = calls
			},
		}
		observeAgentSessionPrompts(proto, () => {
			calls++
		})

		await proto.prompt("hi")

		expect(callsAtOriginalEntry).toBe(1)
	})

	it("forwards text, options and this to the original and returns its promise", async () => {
		const options: PromptOptions = { source: "extension" }
		let receivedText: string | undefined
		let receivedOptions: PromptOptions | undefined
		let receivedThis: PromptPrototype | undefined
		const originalResult = undefined
		const proto: PromptPrototype = {
			async prompt(text, promptOptions) {
				receivedText = text
				receivedOptions = promptOptions
				receivedThis = this
				return originalResult
			},
		}
		const instance = Object.create(proto) as PromptPrototype
		observeAgentSessionPrompts(proto, () => {})

		const result = await instance.prompt("hi", options)

		expect(receivedText).toBe("hi")
		expect(receivedOptions).toBe(options)
		expect(receivedThis).toBe(instance)
		expect(result).toBe(originalResult)
	})

	it("notes a slash command too", async () => {
		let calls = 0
		const proto: PromptPrototype = { async prompt() {} }
		observeAgentSessionPrompts(proto, () => {
			calls++
		})

		await proto.prompt("/language")

		expect(calls).toBe(1)
	})
})
