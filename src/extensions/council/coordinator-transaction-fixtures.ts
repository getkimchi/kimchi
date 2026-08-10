import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, ToolCall } from "@earendil-works/pi-ai"
import { afterEach, vi } from "vitest"
import { DEFAULT_COUNCIL_CONFIG } from "./config.js"
import { createCouncilStream } from "./coordinator.js"
import { councilModel, createModelRegistryMock, physicalModel, response } from "./council-test-harness.js"
import type { CouncilConfig, CouncilRunRecord } from "./schemas.js"
import { COUNCIL_CHECK_TOOL, type CouncilPromotionRequest, CouncilTransactionRuntime } from "./transaction.js"
import type { ValidationCheck } from "./validation.js"

// A plain `import {...}; export {...}` pair for names re-exported from `council-test-harness.js` comes
// back `undefined` in this file: with a `vi.mock` present, Vitest's hoisting transform captures the
// re-export before the underlying import settles. `export ... from` (a genuine re-export declaration)
// does not have this problem, so it's used here instead of the more common two-statement form.
export { councilModel, redactObjectStringsMock, response, toolResponse } from "./council-test-harness.js"

// Self-hoisting registration for the shared redactor spy: see the comment on `redactObjectStringsMock`
// in `council-test-harness.js` for why this file needs its own `vi.mock` rather than relying on the
// import above.
vi.mock("../pii-redaction/redactor.js", async () => {
	const { redactObjectStringsMock } = await import("./council-test-harness.js")
	return { redactObjectStrings: redactObjectStringsMock }
})

const roots: string[] = []
const validationChecks: ValidationCheck[] = [
	{
		id: "package.test",
		kind: "test",
		cwd: ".",
		executable: "node",
		args: ["--test"],
		timeoutMs: 30_000,
		mutationPolicy: "read-only",
		expectedOutputs: [],
	},
]

export const candidateText = Array.from({ length: 12 }, (_, index) => `candidate ${index}\n`).join("")

export function transactionRuntime(root: string): CouncilTransactionRuntime {
	return new CouncilTransactionRuntime(root, undefined, validationChecks)
}

export const physicalModels = new Map(
	["lead", "solver-a", "solver-b", "solver-c", "analyst", "fallback"].map((id) => [
		id,
		physicalModel(id, { provider: "test" }),
	]),
)

export const modelRegistry = createModelRegistryMock(physicalModels, "test")

export const config: CouncilConfig = {
	...DEFAULT_COUNCIL_CONFIG,
	lead: { primary: "test/lead", fallbacks: [] },
	panel: [
		{ primary: "test/solver-a", fallbacks: [] },
		{ primary: "test/solver-b", fallbacks: [] },
		{ primary: "test/solver-c", fallbacks: [] },
	],
	panelSize: 3,
	analyst: { primary: "test/analyst", fallbacks: [] },
	budget: {
		...DEFAULT_COUNCIL_CONFIG.budget,
		maxRetriesPerCall: 0,
	},
}

export function promotionRequestFromToolCall(call: ToolCall): CouncilPromotionRequest {
	const { transaction_id: transactionId, patch_sha256: patchSha256 } = call.arguments as {
		transaction_id: string
		patch_sha256: string
	}
	return { transactionId, patchSha256 }
}

export function patchFor(modelId: string, content = `${modelId} solution\n`) {
	return {
		operations: [{ op: "update", path: "file.txt", content }],
	}
}

export const cleanAnalysis = {
	consensus: ["The solutions address the requested file."],
	contradictions: [],
	partial_coverage: [],
	unique_insights: [],
	blind_spots: [],
	required_checks: ["package.test"],
}

export function createModelDriver(
	options: {
		invalidSolvers?: readonly string[]
		synthesisContent?: string
		synthesisSummary?: string
		omitSynthesisSummary?: boolean
		leadText?: string
	} = {},
) {
	const invalidSolvers = new Set(options.invalidSolvers ?? [])
	const summaryFields = (): { summary?: string } =>
		options.omitSynthesisSummary ? {} : { summary: options.synthesisSummary ?? "Applied the requested change." }
	const completeModel = vi.fn(
		async (model: Model<Api>, context: Context, _options?: SimpleStreamOptions): Promise<AssistantMessage> => {
			const systemPrompt = context.systemPrompt ?? ""
			if (systemPrompt.includes("You are a Council solver.")) {
				return invalidSolvers.has(model.id)
					? response(model, "not json")
					: response(model, JSON.stringify(patchFor(model.id)))
			}
			if (systemPrompt.includes("You are the Council analyst.")) return response(model, JSON.stringify(cleanAnalysis))
			if (systemPrompt.includes("Compare the supplied solutions and write the final patch")) {
				return response(
					model,
					JSON.stringify({
						analysis: cleanAnalysis,
						...summaryFields(),
						patch: patchFor(model.id, options.synthesisContent),
					}),
				)
			}
			if (systemPrompt.includes("You are the Council lead. Write the final patch"))
				return response(
					model,
					JSON.stringify({
						...summaryFields(),
						patch: patchFor(model.id, options.synthesisContent),
					}),
				)
			return response(model, options.leadText ?? "Lead candidate summary.")
		},
	)

	return { completeModel }
}

export function runCouncil(
	runtime: CouncilTransactionRuntime,
	completeModel: ReturnType<typeof createModelDriver>["completeModel"],
	options?: SimpleStreamOptions,
	runConfig: CouncilConfig = config,
	recordRun?: (record: CouncilRunRecord) => void,
) {
	return createCouncilStream({
		config: runConfig,
		getModelRegistry: () => modelRegistry,
		completeModel,
		transaction: runtime,
		recordRun,
		shouldReviewTurn: () => true,
	})(
		councilModel,
		{
			messages: [{ role: "user", content: "Make the requested change.", timestamp: 1 }],
			tools: [
				{ name: "write", description: "Write a file", parameters: { type: "object" } },
				{ name: "bash", description: "Run a shell command", parameters: { type: "object" } },
				{
					name: COUNCIL_CHECK_TOOL,
					description: "Verify the staged candidate",
					parameters: { type: "object" },
				},
			],
		},
		options,
	)
}

export async function fixture(): Promise<{ root: string; file: string }> {
	const root = await mkdtemp(join(tmpdir(), "council-coordinator-transaction-"))
	const file = join(root, "file.txt")
	await writeFile(file, "before\n")
	roots.push(root)
	return { root, file }
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
