import { AgentSession } from "@earendil-works/pi-coding-agent"
import { expect, it, vi } from "vitest"
import { applySameModelSelectPatch } from "./same-model-select-patch.js"

it("emits model_select when the user reselects the active model", async () => {
	const model = {
		id: "thinker",
		name: "Thinker",
		provider: "fake",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
	} as const
	const emit = vi.fn().mockResolvedValue(undefined)
	const session = { _extensionRunner: { emit } }
	// biome-ignore lint/suspicious/noExplicitAny: invoking the patched private upstream method on a focused fake
	const patched = (AgentSession.prototype as any)._emitModelSelect

	await patched.call(session, model, model, "set")

	expect(emit).toHaveBeenCalledOnce()
	expect(emit).toHaveBeenCalledWith({
		type: "model_select",
		model,
		previousModel: model,
		source: "set",
	})
})

it("does not patch when Pi's private model-select hook is unavailable", () => {
	// biome-ignore lint/suspicious/noExplicitAny: simulating a future Pi version without the private hook
	const prototype = AgentSession.prototype as any
	const current = prototype._emitModelSelect
	prototype._emitModelSelect = undefined

	try {
		applySameModelSelectPatch()
		expect(prototype._emitModelSelect).toBeUndefined()
	} finally {
		prototype._emitModelSelect = current
	}
})
