import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai"
import { CouncilSessionCache } from "./cache.js"
import type { PhysicalInvocationResult } from "./physical-invoker.js"
import type { CouncilRunContext } from "./run-context.js"
import { type CouncilStageRuntime, RepairBudget, type StructuredStagePrepareContext } from "./stage-runner.js"
import { ZERO_USAGE } from "./telemetry.js"

function message(text: string, modelRef: string): AssistantMessage {
	const [provider, model] = modelRef.split("/")
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: provider ?? "physical",
		model: model ?? "primary",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 1,
	}
}

export interface StageInvocationCall {
	stage: string
	pool: { primary: string; fallbacks: string[] }
	context: Context
	prepareContext?: StructuredStagePrepareContext
}

export interface StageTestHarness {
	rt: CouncilStageRuntime
	physicalCalls: StageInvocationCall[]
	repairCalls: Array<{ stage: string; context: Context }>
}

export function stageTestHarness(physicalOutputs: string[], repairOutputs: string[] = []): StageTestHarness {
	const physicalCalls: StageInvocationCall[] = []
	const repairCalls: Array<{ stage: string; context: Context }> = []
	const rt: CouncilStageRuntime = {
		run: { throwIfAborted() {} } as unknown as CouncilRunContext,
		cache: new CouncilSessionCache(),
		repairBudget: new RepairBudget(),
		maxStructuredBytes: 1_000_000,
		invoke: async (stage, _pool, context) => {
			repairCalls.push({ stage, context })
			return message(repairOutputs.shift() ?? "{}", "physical/repair")
		},
		invokePhysical: async (stage, pool, context, _maxTokens, _timeoutMs, prepareContext) => {
			physicalCalls.push({ stage, pool, context, prepareContext })
			return {
				message: message(physicalOutputs.shift() ?? "{}", pool.primary),
				model: {} as Model<Api>,
				modelRef: pool.primary,
				attempts: 1,
			} satisfies PhysicalInvocationResult
		},
		structuredText: (_stage, result) =>
			result.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join(""),
		markStageError() {},
		startStage() {},
		completeStage() {},
		failStage() {},
		rethrowTerminalFailure() {},
		pushStage() {},
	}
	return { rt, physicalCalls, repairCalls }
}
