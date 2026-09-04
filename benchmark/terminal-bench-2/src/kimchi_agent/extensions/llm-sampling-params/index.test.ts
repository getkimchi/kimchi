import type { Model } from "@earendil-works/pi-ai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import llmSamplingParamsExtension, {
	ENV_LLM_PARAMS_JSON,
	ENV_LLM_PER_MODEL_PARAMS_JSON,
	parseParameters,
} from "./index.js"

function makeModel(
	overrides: Partial<{
		provider: string
		id: string
		compat?: { maxTokensField?: "max_tokens" | "max_completion_tokens" }
	}> = {},
): Model<string> {
	return {
		provider: overrides.provider ?? "kimchi-dev",
		id: overrides.id ?? "kimi-k2.6",
		compat: overrides.compat ?? { maxTokensField: "max_tokens" },
	} as Model<string>
}

function makePi(model: Model<string>) {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>()
	return {
		on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			if (!handlers.has(event)) handlers.set(event, [])
			handlers.get(event)!.push(handler)
		}),
		_fire: (event: string, payload: Record<string, unknown>): Record<string, unknown> => {
			const list = handlers.get(event) ?? []
			let result = payload
			for (const h of list) {
				result = h({ payload: result }, { model }) as Record<string, unknown>
			}
			return result
		},
	}
}

describe("parseParameters", () => {
	it("returns empty object for undefined input", () => {
		expect(parseParameters(undefined)).toEqual({})
	})

	it("parses valid parameters", () => {
		expect(parseParameters('{"temperature": 0.7, "top_p": 0.9, "max_tokens": 4096}')).toEqual({
			temperature: 0.7,
			top_p: 0.9,
			max_tokens: 4096,
		})
	})

	it("rejects non-numeric values", () => {
		expect(() => parseParameters('{"temperature": "low"}')).toThrow("must be a number")
	})
})

describe("llmSamplingParamsExtension", () => {
	let prevEnv: NodeJS.ProcessEnv

	beforeEach(() => {
		prevEnv = { ...process.env }
	})

	afterEach(() => {
		process.env = prevEnv
	})

	it("applies global parameters to the provider payload", () => {
		process.env[ENV_LLM_PARAMS_JSON] = '{"temperature": 0.7, "top_p": 0.9, "top_k": 40, "max_tokens": 4096}'
		delete process.env[ENV_LLM_PER_MODEL_PARAMS_JSON]

		const pi = makePi(makeModel())
		llmSamplingParamsExtension(pi as any)

		const result = pi._fire("before_provider_request", { messages: [] })
		expect(result).toEqual({ messages: [], temperature: 0.7, top_p: 0.9, top_k: 40, max_tokens: 4096 })
	})

	it("uses per-model overrides over global parameters", () => {
		process.env[ENV_LLM_PARAMS_JSON] = '{"temperature": 0.7, "top_k": 40}'
		process.env[ENV_LLM_PER_MODEL_PARAMS_JSON] =
			'{"kimchi-dev/kimi-k2.6": {"temperature": 0.2, "top_k": 20, "max_tokens": 8192}}'

		const pi = makePi(makeModel())
		llmSamplingParamsExtension(pi as any)

		const result = pi._fire("before_provider_request", { messages: [] })
		expect(result).toEqual({ messages: [], temperature: 0.2, top_k: 20, max_tokens: 8192 })
	})

	it("uses max_completion_tokens when model compat requests it", () => {
		process.env[ENV_LLM_PARAMS_JSON] = '{"max_tokens": 4096}'
		delete process.env[ENV_LLM_PER_MODEL_PARAMS_JSON]

		const pi = makePi(makeModel({ compat: { maxTokensField: "max_completion_tokens" } }))
		llmSamplingParamsExtension(pi as any)

		const result = pi._fire("before_provider_request", { messages: [] })
		expect(result).toEqual({ messages: [], max_completion_tokens: 4096 })
		expect(result).not.toHaveProperty("max_tokens")
	})

	it("does not mutate payload when no params are set", () => {
		delete process.env[ENV_LLM_PARAMS_JSON]
		delete process.env[ENV_LLM_PER_MODEL_PARAMS_JSON]

		const pi = makePi(makeModel())
		llmSamplingParamsExtension(pi as any)

		const result = pi._fire("before_provider_request", { messages: [] })
		expect(result).toEqual({ messages: [] })
	})

	it("returns payload unchanged when model is not in ctx", () => {
		process.env[ENV_LLM_PARAMS_JSON] = '{"temperature": 0.7}'
		delete process.env[ENV_LLM_PER_MODEL_PARAMS_JSON]

		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>()
		const pi = {
			on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				if (!handlers.has(event)) handlers.set(event, [])
				handlers.get(event)!.push(handler)
			}),
			_fire: (event: string, payload: Record<string, unknown>): Record<string, unknown> => {
				const list = handlers.get(event) ?? []
				let result = payload
				for (const h of list) {
					result = h({ payload: result }, { model: undefined }) as Record<string, unknown>
				}
				return result
			},
		}
		llmSamplingParamsExtension(pi as any)

		const result = pi._fire("before_provider_request", { messages: [] })
		expect(result).toEqual({ messages: [] })
		expect(result).not.toHaveProperty("temperature")
	})
})
