import type { Model } from "@earendil-works/pi-ai"
import type { ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import {
	AUTO_RESOLUTION_ENTRY,
	clearAutoRoutingState,
	getAutoRoutingState,
	getEffectiveModel,
	hydrateAutoRoutingState,
	resolvedEntry,
	resolveEffectiveModel,
	sessionSelectsAuto,
	setAutoRoutingState,
} from "./state.js"

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

function custom(data: unknown): SessionEntry {
	return {
		type: "custom",
		id: crypto.randomUUID(),
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: AUTO_RESOLUTION_ENTRY,
		data,
	}
}

function modelChange(modelId: string): SessionEntry {
	return {
		type: "model_change",
		id: crypto.randomUUID(),
		parentId: null,
		timestamp: new Date().toISOString(),
		provider: "kimchi-dev",
		modelId,
	}
}

function registry(models: Model<string>[]) {
	return {
		find: (provider: string, id: string) => models.find((item) => item.provider === provider && item.id === id),
		getAvailable: () => models,
	} as Pick<ModelRegistry, "find" | "getAvailable">
}

afterEach(() => clearAutoRoutingState(SESSION_ID))

describe("effective model resolution", () => {
	it("returns a concrete context model without reading the session", () => {
		const getSessionId = vi.fn(() => SESSION_ID)
		const ctx = createContext({ model: model("concrete"), sessionManager: { getSessionId } })

		expect(getEffectiveModel(ctx)).toBe(ctx.model)
		expect(getSessionId).not.toHaveBeenCalled()
	})

	it("resolves Auto from the context's session", () => {
		const target = model("routed")
		setAutoRoutingState(SESSION_ID, { status: "resolved", model: target })
		const ctx = createContext({
			model: model("auto"),
			sessionManager: { getSessionId: () => SESSION_ID },
		})

		expect(getEffectiveModel(ctx)).toBe(target)
	})

	it("supports integration boundaries that have a model and session ID but no context", () => {
		const target = model("routed")
		setAutoRoutingState(SESSION_ID, { status: "resolved", model: target })

		expect(resolveEffectiveModel(model("auto"), SESSION_ID)).toBe(target)
	})
})

describe("hydrateAutoRoutingState", () => {
	it("starts unresolved when the session has no successful selection", () => {
		expect(hydrateAutoRoutingState(SESSION_ID, [], registry([]))).toEqual({ status: "unresolved" })
	})

	it("restores a successful concrete resolution", () => {
		const target = model("kimi-k2.5")
		const state = hydrateAutoRoutingState(SESSION_ID, [custom(resolvedEntry(target))], registry([target]))

		expect(state).toEqual({ status: "resolved", model: target })
		expect(getAutoRoutingState(SESSION_ID)).toEqual(state)
	})

	it("ignores legacy attempt entries because transient routing state is not durable", () => {
		const state = hydrateAutoRoutingState(SESSION_ID, [custom({ version: 1, status: "attempting" })], registry([]))
		expect(state).toEqual({ status: "unresolved" })
	})

	it("does not revive a saved target that is no longer available", () => {
		const state = hydrateAutoRoutingState(
			SESSION_ID,
			[custom({ version: 1, status: "resolved", provider: "kimchi-dev", modelId: "gone" })],
			registry([]),
		)
		expect(state).toEqual({ status: "failed", reason: "unavailable_recommendation" })
	})

	it("ignores legacy failure entries because failures can be retried", () => {
		const state = hydrateAutoRoutingState(
			SESSION_ID,
			[custom({ version: 1, status: "failed", reason: "timeout" })],
			registry([]),
		)

		expect(state).toEqual({ status: "unresolved" })
	})
})

describe("sessionSelectsAuto", () => {
	it("treats persisted routing state as an Auto selection", () => {
		expect(sessionSelectsAuto([custom(resolvedEntry(model("routed")))])).toBe(true)
	})

	it("ignores corrupted routing entries", () => {
		expect(sessionSelectsAuto([custom({ version: 1, status: "not-real" })])).toBe(false)
	})

	it("does not treat legacy attempts or failures as successful Auto selections", () => {
		expect(
			sessionSelectsAuto([
				custom({ version: 1, status: "attempting" }),
				custom({ version: 1, status: "failed", reason: "timeout" }),
			]),
		).toBe(false)
	})

	it("lets a later concrete model selection override Auto", () => {
		expect(sessionSelectsAuto([custom(resolvedEntry(model("routed"))), modelChange("override")])).toBe(false)
	})

	it("recognizes a later explicit switch back to Auto", () => {
		expect(
			sessionSelectsAuto([custom(resolvedEntry(model("routed"))), modelChange("override"), modelChange("auto")]),
		).toBe(true)
	})
})
