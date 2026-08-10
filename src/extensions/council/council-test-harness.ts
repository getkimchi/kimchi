import type { Api, AssistantMessage, Context, Model, ToolCall, Usage } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { vi } from "vitest"

// The one spy behind every `../pii-redaction/redactor.js` mock in council tests. `vi.mock` factories
// are hoisted above a file's own imports, so a mock declared *here* can't protect a sibling import of
// `coordinator.js`/`context-compiler.js` in a *different* file — evaluation order between two sibling
// imports follows declaration order, and an import-sorting formatter will always place those ahead of
// this file alphabetically. So this module holds the spy only; each entry point that itself imports
// `coordinator.js` or `context-compiler.js` (`runtime-test-harness.ts`, `coordinator-transaction-fixtures.ts`,
// `context-compiler.test.ts`) registers its own `vi.mock`, self-hoisted above its own imports, with a
// factory that lazily `await import()`s this module so every registration resolves to this same spy.
const { redactObjectStringsMock } = vi.hoisted(() => ({
	redactObjectStringsMock: vi.fn(async (value: unknown) => value),
}))

export { redactObjectStringsMock }

export const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export function physicalModel(
	id: string,
	options: { provider?: string; baseUrl?: string; reasoning?: boolean; maxTokens?: number } = {},
): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: options.provider ?? "test",
		baseUrl: options.baseUrl ?? "http://localhost.invalid",
		reasoning: options.reasoning ?? false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 262_144,
		maxTokens: options.maxTokens ?? 4096,
	}
}

/** One mock model registry, parameterized by which physical-model catalog and provider it serves. */
export function createModelRegistryMock(
	models: Map<string, Model<Api>>,
	provider: string,
	getApiKeyAndHeaders: ModelRegistry["getApiKeyAndHeaders"] = vi.fn(async () => ({
		ok: true as const,
		apiKey: "test-key",
	})),
): Pick<ModelRegistry, "find" | "getApiKeyAndHeaders"> {
	return {
		find: vi.fn((candidateProvider: string, id: string) =>
			candidateProvider === provider ? models.get(id) : undefined,
		),
		getApiKeyAndHeaders,
	} satisfies Pick<ModelRegistry, "find" | "getApiKeyAndHeaders">
}

export function usage(tokens = 1): Usage {
	return {
		input: tokens,
		output: tokens,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: tokens * 2,
		cost: { ...ZERO_COST, total: 0 },
	}
}

export function response(model: Model<Api>, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
	}
}

export function toolResponse(model: Model<Api>, call: ToolCall): AssistantMessage {
	return {
		...response(model, ""),
		content: [call],
		stopReason: "toolUse",
	}
}

/** Reads the JSON packet a stage sent as the last user message in its request context. */
export function stageInput(context: Context): Record<string, unknown> {
	const message = context.messages.at(-1)
	if (message?.role !== "user" || typeof message.content !== "string") throw new Error("missing stage input")
	return JSON.parse(message.content) as Record<string, unknown>
}

export const councilModel = {
	id: "council",
	name: "Kimchi Council",
	api: "kimchi-council",
	provider: "kimchi",
	baseUrl: "http://localhost.invalid",
	reasoning: false,
	input: ["text"] as const,
	cost: ZERO_COST,
	contextWindow: 262_144,
	maxTokens: 32_768,
} satisfies Model<Api>
