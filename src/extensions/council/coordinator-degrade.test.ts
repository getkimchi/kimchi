import { readFile } from "node:fs/promises"
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { createCouncilStream } from "./coordinator.js"
import {
	candidateText,
	cleanAnalysis,
	config,
	councilModel,
	createModelDriver,
	fixture,
	modelRegistry,
	response,
	runCouncil,
	transactionRuntime,
} from "./coordinator-transaction-fixtures.js"
import { RunFailure } from "./run-context.js"
import type { CouncilRunRecord } from "./schemas.js"
import { COUNCIL_APPLY_TOOL } from "./transaction.js"

async function stageLeadCandidate(root: string) {
	const runtime = transactionRuntime(root)
	await runtime.ensure().stageWrite("file.txt", candidateText)
	return runtime
}

function solverPatchResponse(model: Model<Api>) {
	return response(
		model,
		JSON.stringify({ operations: [{ op: "update", path: "file.txt", content: `${model.id} solution\n` }] }),
	)
}

async function applyAndRead(
	runtime: ReturnType<typeof transactionRuntime>,
	file: string,
	toolCall: AssistantMessage["content"][number] | undefined,
) {
	if (toolCall?.type !== "toolCall") throw new Error("missing apply tool call")
	await runtime.apply({
		transactionId: String(toolCall.arguments.transaction_id),
		patchSha256: String(toolCall.arguments.patch_sha256),
	})
	return readFile(file, "utf8")
}

// A comparison-layer failure (panel, analyst, synthesis, combined, or the whole-run deadline/budget
// being hit while they run) must promote the lead's own already-staged candidate instead of losing
// the turn. Council only fails a turn outright when the lead itself produced no candidate, or when
// applying/validating the winning patch fails for safety reasons.
describe("coordinator degrade-to-lead-candidate", () => {
	it("promotes the lead candidate when the analyst stage fails", async () => {
		const { root, file } = await fixture()
		const runtime = await stageLeadCandidate(root)
		const driver = createModelDriver()
		driver.completeModel.mockImplementation(async (model: Model<Api>, context: Context) => {
			const systemPrompt = context.systemPrompt ?? ""
			if (systemPrompt.includes("You are a Council solver.")) return solverPatchResponse(model)
			if (systemPrompt.includes("You are the Council analyst.")) throw new Error("analyst provider failure")
			return response(model, "Lead candidate summary.")
		})
		const records: CouncilRunRecord[] = []

		const result = await runCouncil(runtime, driver.completeModel, undefined, config, (record) =>
			records.push(record),
		).result()
		await new Promise((resolve) => setImmediate(resolve))
		await new Promise((resolve) => setImmediate(resolve))

		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(records.at(-1)).toMatchObject({ outcome: "tool_use", degradedReason: "analyst_failed" })
		expect(await applyAndRead(runtime, file, result.content[0])).toBe(candidateText)
	})

	it("promotes the lead candidate when the synthesis stage fails", async () => {
		const { root, file } = await fixture()
		const runtime = await stageLeadCandidate(root)
		const driver = createModelDriver()
		driver.completeModel.mockImplementation(async (model: Model<Api>, context: Context) => {
			const systemPrompt = context.systemPrompt ?? ""
			if (systemPrompt.includes("You are a Council solver.")) return solverPatchResponse(model)
			if (systemPrompt.includes("You are the Council analyst.")) return response(model, JSON.stringify(cleanAnalysis))
			if (systemPrompt.includes("You are the Council lead. Write the final patch"))
				throw new Error("synthesis provider failure")
			return response(model, "Lead candidate summary.")
		})
		const records: CouncilRunRecord[] = []

		const result = await runCouncil(runtime, driver.completeModel, undefined, config, (record) =>
			records.push(record),
		).result()
		await new Promise((resolve) => setImmediate(resolve))
		await new Promise((resolve) => setImmediate(resolve))

		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(records.at(-1)).toMatchObject({ outcome: "tool_use", degradedReason: "synthesis_failed" })
		expect(await applyAndRead(runtime, file, result.content[0])).toBe(candidateText)
	})

	it("promotes the lead candidate when the fast preset's combined stage fails", async () => {
		const { root, file } = await fixture()
		const runtime = await stageLeadCandidate(root)
		const driver = createModelDriver()
		const fastModel: Model<Api> = { ...councilModel, id: "council-fast" }
		driver.completeModel.mockImplementation(async (model: Model<Api>, context: Context) => {
			const systemPrompt = context.systemPrompt ?? ""
			if (systemPrompt.includes("You are a Council solver.")) return solverPatchResponse(model)
			if (systemPrompt.includes("Compare the supplied solutions and write the final patch"))
				throw new Error("combined provider failure")
			return response(model, "Lead candidate summary.")
		})
		const records: CouncilRunRecord[] = []

		const stream = createCouncilStream({
			config,
			getModelRegistry: () => modelRegistry,
			completeModel: driver.completeModel,
			transaction: runtime,
			shouldReviewTurn: () => true,
			recordRun: (record) => records.push(record),
		})(fastModel, {
			messages: [{ role: "user", content: "Make the requested change.", timestamp: 1 }],
			tools: [
				{ name: "write", description: "Write a file", parameters: { type: "object" } },
				{ name: "bash", description: "Run a shell command", parameters: { type: "object" } },
			],
		})
		const result = await stream.result()
		await new Promise((resolve) => setImmediate(resolve))
		await new Promise((resolve) => setImmediate(resolve))

		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(records.at(-1)).toMatchObject({ outcome: "tool_use", degradedReason: "analyst_failed" })
		expect(await applyAndRead(runtime, file, result.content[0])).toBe(candidateText)
	})

	it("promotes the lead candidate when the whole-run deadline is exceeded during the panel", async () => {
		const { root, file } = await fixture()
		const runtime = await stageLeadCandidate(root)
		const driver = createModelDriver()
		driver.completeModel.mockImplementation(async (model: Model<Api>, context: Context) => {
			const systemPrompt = context.systemPrompt ?? ""
			if (systemPrompt.includes("You are a Council solver."))
				throw new RunFailure("deadline_exceeded", "Council whole-run deadline exceeded")
			return response(model, "Lead candidate summary.")
		})
		const records: CouncilRunRecord[] = []

		const result = await runCouncil(runtime, driver.completeModel, undefined, config, (record) =>
			records.push(record),
		).result()
		await new Promise((resolve) => setImmediate(resolve))
		await new Promise((resolve) => setImmediate(resolve))

		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(records.at(-1)).toMatchObject({ outcome: "tool_use", degradedReason: "deadline_exceeded" })
		expect(await applyAndRead(runtime, file, result.content[0])).toBe(candidateText)
	})

	it("promotes the lead candidate when the whole-run budget is exhausted during the panel", async () => {
		const { root, file } = await fixture()
		const runtime = await stageLeadCandidate(root)
		const driver = createModelDriver()
		const tightConfig = { ...config, budget: { ...config.budget, maxLogicalCalls: 1 } }
		const records: CouncilRunRecord[] = []

		const result = await runCouncil(runtime, driver.completeModel, undefined, tightConfig, (record) =>
			records.push(record),
		).result()
		await new Promise((resolve) => setImmediate(resolve))
		await new Promise((resolve) => setImmediate(resolve))

		expect(
			driver.completeModel.mock.calls.some(([_, context]) => context.systemPrompt?.includes("Council solver")),
		).toBe(false)
		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(records.at(-1)).toMatchObject({ outcome: "tool_use", degradedReason: "budget_exceeded" })
		expect(await applyAndRead(runtime, file, result.content[0])).toBe(candidateText)
	})

	it("still fails when the lead itself produces no candidate", async () => {
		// The panel, analyst, and synthesis stages only run once the lead has staged a candidate, so
		// the only way for "no candidate" to coincide with a stage failure is the lead stage itself
		// failing before it ever produces one.
		const { root } = await fixture()
		const runtime = transactionRuntime(root)
		const driver = createModelDriver()
		driver.completeModel.mockImplementation(async () => {
			throw new Error("physical model unavailable")
		})
		const records: CouncilRunRecord[] = []

		const result = await runCouncil(runtime, driver.completeModel, undefined, config, (record) =>
			records.push(record),
		).result()

		expect(result.stopReason).toBe("error")
		expect(records.at(-1)?.outcome).toBe("error")
		expect(records.at(-1)?.degradedReason).toBeUndefined()
	})
})
