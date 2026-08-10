import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai"
import { vi } from "vitest"
import { createCouncilStream } from "./coordinator.js"
import { config, councilModel, modelRegistry, response } from "./coordinator-transaction-fixtures.js"
import { stageInput } from "./council-test-harness.js"
import type { CouncilConfig, CouncilRunRecord } from "./schemas.js"

export { config, councilModel, modelRegistry, response, stageInput }

/** Long enough to clear `mayDeliberateCouncilAnswer` / `shouldDeliberateCouncilAnswer`'s request bar. */
export const substantialRequest =
	"Research the tradeoffs between our current caching strategy and a write-through cache, and recommend one for the payments service."

/** Long enough (both by length and by line count) to clear the answer half of the same bar. */
export function substantialAnswer(id: string): string {
	return Array.from(
		{ length: 5 },
		(_, index) =>
			`${id} paragraph ${index}: this line explains part of the answer in enough detail to look substantive.`,
	).join("\n")
}

export const cleanTextAnalysis = {
	consensus: ["Both answers recommend the write-through cache"],
	contradictions: [],
	partial_coverage: [],
	unique_insights: [],
	blind_spots: [],
}

export function createTextModelDriver(
	options: {
		invalidSolvers?: readonly string[]
		leadText?: string
		synthesisAnswer?: string
		analysis?: Record<string, unknown>
	} = {},
) {
	const invalidSolvers = new Set(options.invalidSolvers ?? [])
	const completeModel = vi.fn(
		async (model: Model<Api>, context: Context, _options?: SimpleStreamOptions): Promise<AssistantMessage> => {
			const systemPrompt = context.systemPrompt ?? ""
			if (systemPrompt.includes("You are a Council solver. Answer the objective")) {
				return invalidSolvers.has(model.id)
					? response(model, "not json")
					: response(model, JSON.stringify({ answer: substantialAnswer(model.id) }))
			}
			if (systemPrompt.includes("You are the Council analyst. Compare the independently generated answers")) {
				return response(model, JSON.stringify(options.analysis ?? cleanTextAnalysis))
			}
			if (systemPrompt.includes("You are the Council lead. Write the final answer")) {
				return response(model, JSON.stringify({ answer: options.synthesisAnswer ?? "Use a write-through cache." }))
			}
			return response(model, options.leadText ?? substantialAnswer("lead"))
		},
	)
	return { completeModel }
}

export function runTextCouncil(
	completeModel: ReturnType<typeof createTextModelDriver>["completeModel"],
	options?: SimpleStreamOptions,
	runConfig: CouncilConfig = config,
	recordRun?: (record: CouncilRunRecord) => void,
	requestText: string = substantialRequest,
) {
	return createCouncilStream({
		config: runConfig,
		getModelRegistry: () => modelRegistry,
		completeModel,
		recordRun,
		shouldReviewTurn: () => false,
	})(councilModel, { messages: [{ role: "user", content: requestText, timestamp: 1 }] }, options)
}
