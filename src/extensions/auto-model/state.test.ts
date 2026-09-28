import type { Model } from "@earendil-works/pi-ai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { clearAutoRoutingState, getEffectiveModel, resolveEffectiveModel, setAutoRoutingState } from "./state.js"

const SESSION_ID = "session-1"

function model(id: string): Model<string> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "kimchi-dev",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	}
}

afterEach(() => clearAutoRoutingState(SESSION_ID))

describe("effective model resolution", () => {
	it("returns a concrete context model without reading the session", () => {
		const getSessionId = vi.fn(() => SESSION_ID)
		const ctx = createContext({ model: model("concrete"), sessionManager: { getSessionId } })

		expect(getEffectiveModel(ctx)).toBe(ctx.model)
		expect(getSessionId).not.toHaveBeenCalled()
	})

	it("resolves a routed virtual model from the context's session", () => {
		const target = model("routed")
		setAutoRoutingState(SESSION_ID, { status: "resolved", model: target, requestedId: "auto" })
		const ctx = createContext({
			model: model("auto"),
			sessionManager: { getSessionId: () => SESSION_ID },
		})

		expect(getEffectiveModel(ctx)).toBe(target)
	})

	it("supports integration boundaries that have a model and session ID but no context", () => {
		const target = model("routed")
		setAutoRoutingState(SESSION_ID, { status: "resolved", model: target, requestedId: "auto" })

		expect(resolveEffectiveModel(model("auto"), SESSION_ID)).toBe(target)
	})

	it("resolves any routed virtual model via its requestedId (id-agnostic)", () => {
		const target = model("kimi-k3")
		setAutoRoutingState(SESSION_ID, { status: "resolved", model: target, requestedId: "auto-beta" })

		expect(resolveEffectiveModel(model("auto-beta"), SESSION_ID)).toBe(target)
	})

	it("does not resolve a requestedId-scoped state for a different virtual model", () => {
		const target = model("kimi-k3")
		setAutoRoutingState(SESSION_ID, { status: "resolved", model: target, requestedId: "auto-beta" })

		const other = model("auto")
		expect(resolveEffectiveModel(other, SESSION_ID)).toBe(other)
	})

	it("leaves unresolved sessions on the selected model", () => {
		const requested = model("auto")
		expect(resolveEffectiveModel(requested, SESSION_ID)).toBe(requested)
	})
})
