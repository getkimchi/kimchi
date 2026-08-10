import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai"
import { describe, expect, it, vi } from "vitest"
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
import { stageInput } from "./council-test-harness.js"
import { COUNCIL_APPLY_TOOL } from "./transaction-tools.js"
import type { CouncilRunRecord } from "./types.js"

async function stageLeadCandidate(root: string, content = candidateText) {
	const runtime = transactionRuntime(root)
	await runtime.ensure().stageWrite("file.txt", content)
	return runtime
}

describe("coordinator fusion", () => {
	it("freezes one packet, counts the lead as member one, and isolates concurrent solvers", async () => {
		const { root } = await fixture()
		const runtime = await stageLeadCandidate(
			root,
			Array.from({ length: 12 }, (_, index) => `lead candidate ${index}\n`).join(""),
		)
		const driver = createModelDriver()
		const records: CouncilRunRecord[] = []

		const result = await runCouncil(runtime, driver.completeModel, undefined, config, (record) =>
			records.push(record),
		).result()
		await new Promise((resolve) => setImmediate(resolve))
		await new Promise((resolve) => setImmediate(resolve))
		const solverCalls = driver.completeModel.mock.calls.filter(([_, context]) =>
			context.systemPrompt?.includes("You are a Council solver."),
		)
		const solverPackets = solverCalls.map(([_, context]) => stageInput(context))
		const analystCall = driver.completeModel.mock.calls.find(([_, context]) =>
			context.systemPrompt?.includes("You are the Council analyst."),
		)
		if (!analystCall) throw new Error("missing analyst call")
		const comparison = stageInput(analystCall[1])
		const solutions = comparison.solutions as Array<{ diff: string }>

		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(solverCalls).toHaveLength(2)
		expect(solverPackets[0]).toEqual(solverPackets[1])
		expect(JSON.stringify(solverPackets)).not.toContain("solver-a solution")
		expect(JSON.stringify(solverPackets)).not.toContain("solver-b solution")
		expect(solutions).toHaveLength(3)
		expect(solutions.some(({ diff }) => diff.includes("lead candidate"))).toBe(true)
		expect(JSON.stringify(result.content)).not.toContain("solver-a solution")
		expect(records.at(-1)).toMatchObject({ outcome: "tool_use" })
	})

	it("drops a solver that fails after repair and compares the remaining panel", async () => {
		const { root } = await fixture()
		const runtime = await stageLeadCandidate(root)
		const driver = createModelDriver({ invalidSolvers: ["solver-a"] })

		await runCouncil(runtime, driver.completeModel).result()
		const analystCall = driver.completeModel.mock.calls.find(([_, context]) =>
			context.systemPrompt?.includes("You are the Council analyst."),
		)
		if (!analystCall) throw new Error("missing analyst call")
		expect((stageInput(analystCall[1]).solutions as unknown[]).length).toBe(2)
		expect(
			driver.completeModel.mock.calls.filter(([_, context]) =>
				context.systemPrompt?.includes("Repair the supplied object"),
			),
		).toHaveLength(1)
	})

	it("drops a solver whose patch cannot be rendered and compares the remaining panel with contiguous labels", async () => {
		const { root } = await fixture()
		await mkdir(join(root, "folder"))
		const runtime = await stageLeadCandidate(root)
		const driver = createModelDriver()
		driver.completeModel.mockImplementation(
			async (model: Model<Api>, context: Context, _options?: SimpleStreamOptions): Promise<AssistantMessage> => {
				const systemPrompt = context.systemPrompt ?? ""
				if (systemPrompt.includes("You are a Council solver.")) {
					if (model.id === "solver-a") {
						return response(model, JSON.stringify({ operations: [{ op: "delete", path: "folder" }] }))
					}
					return response(
						model,
						JSON.stringify({ operations: [{ op: "update", path: "file.txt", content: "solver-b solution\n" }] }),
					)
				}
				if (systemPrompt.includes("You are the Council analyst.")) return response(model, JSON.stringify(cleanAnalysis))
				if (systemPrompt.includes("You are the Council lead. Write the final patch"))
					return response(
						model,
						JSON.stringify({
							summary: "Applied.",
							patch: { operations: [{ op: "update", path: "file.txt", content: "final\n" }] },
						}),
					)
				return response(model, "Lead candidate summary.")
			},
		)

		await runCouncil(runtime, driver.completeModel).result()
		const analystCall = driver.completeModel.mock.calls.find(([_, context]) =>
			context.systemPrompt?.includes("You are the Council analyst."),
		)
		if (!analystCall) throw new Error("missing analyst call")
		const solutions = stageInput(analystCall[1]).solutions as Array<{ label: string }>
		expect(solutions).toHaveLength(2)
		expect(solutions.map(({ label }) => label)).toEqual(["Solution A", "Solution B"])
	})

	it("promotes the lead with panel_unavailable when fewer than two patches are usable", async () => {
		const { root } = await fixture()
		const runtime = await stageLeadCandidate(root)
		const driver = createModelDriver({ invalidSolvers: ["solver-a", "solver-b"] })
		const records: CouncilRunRecord[] = []

		const result = await runCouncil(runtime, driver.completeModel, undefined, config, (record) =>
			records.push(record),
		).result()
		await new Promise((resolve) => setImmediate(resolve))
		await new Promise((resolve) => setImmediate(resolve))

		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(
			driver.completeModel.mock.calls.some(([_, context]) => context.systemPrompt?.includes("Council analyst")),
		).toBe(false)
		expect(
			driver.completeModel.mock.calls.some(([_, context]) => context.systemPrompt?.includes("Write the final patch")),
		).toBe(false)
		expect(records.at(-1)).toMatchObject({ outcome: "tool_use", degradedReason: "panel_unavailable" })
	})

	it("degrades with panel_unavailable and applies the lead's patch when every solver patch is unrenderable", async () => {
		const { root } = await fixture()
		await mkdir(join(root, "folder"))
		const runtime = await stageLeadCandidate(root)
		const driver = createModelDriver()
		driver.completeModel.mockImplementation(
			async (model: Model<Api>, context: Context, _options?: SimpleStreamOptions): Promise<AssistantMessage> => {
				const systemPrompt = context.systemPrompt ?? ""
				if (systemPrompt.includes("You are a Council solver.")) {
					return response(model, JSON.stringify({ operations: [{ op: "delete", path: "folder" }] }))
				}
				return response(model, "Lead candidate summary.")
			},
		)
		const records: CouncilRunRecord[] = []

		const result = await runCouncil(runtime, driver.completeModel, undefined, config, (record) =>
			records.push(record),
		).result()
		await new Promise((resolve) => setImmediate(resolve))
		await new Promise((resolve) => setImmediate(resolve))

		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(
			driver.completeModel.mock.calls.some(([_, context]) => context.systemPrompt?.includes("Council analyst")),
		).toBe(false)
		expect(
			driver.completeModel.mock.calls.some(([_, context]) => context.systemPrompt?.includes("Write the final patch")),
		).toBe(false)
		expect(records.at(-1)).toMatchObject({ outcome: "tool_use", degradedReason: "panel_unavailable" })
	})

	it("derives a public message for the panel_unavailable degraded path when the lead has no prose", async () => {
		const { root } = await fixture()
		const runtime = await stageLeadCandidate(root)
		const driver = createModelDriver({ invalidSolvers: ["solver-a", "solver-b", "solver-c"], leadText: "" })
		const records: CouncilRunRecord[] = []

		const result = await runCouncil(runtime, driver.completeModel, undefined, config, (record) =>
			records.push(record),
		).result()
		await new Promise((resolve) => setImmediate(resolve))
		await new Promise((resolve) => setImmediate(resolve))

		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(runtime.acceptedResponse).toBe("Updated file.txt.")
		expect(runtime.acceptedResponse).not.toBe("Candidate patch staged for review.")
		expect(records.at(-1)).toMatchObject({ outcome: "tool_use", degradedReason: "panel_unavailable" })
	})

	it("prefers the lead's own prose over the synthesis summary", async () => {
		const { root } = await fixture()
		const runtime = await stageLeadCandidate(root)
		const driver = createModelDriver({ leadText: "Custom lead prose.", synthesisSummary: "Synthesis summary." })

		const result = await runCouncil(runtime, driver.completeModel).result()

		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(runtime.acceptedResponse).toBe("Custom lead prose.")
	})

	it("applies the lead's own patch with panel_unavailable when every panel model fails to resolve", async () => {
		const { root } = await fixture()
		const runtime = await stageLeadCandidate(root)
		const driver = createModelDriver()
		const records: CouncilRunRecord[] = []
		const unresolvablePanelConfig = {
			...config,
			panel: [
				{ primary: "test/does-not-exist", fallbacks: [] },
				{ primary: "test/does-not-exist", fallbacks: [] },
				{ primary: "test/does-not-exist", fallbacks: [] },
			],
		}

		const result = await runCouncil(runtime, driver.completeModel, undefined, unresolvablePanelConfig, (record) =>
			records.push(record),
		).result()
		await new Promise((resolve) => setImmediate(resolve))
		await new Promise((resolve) => setImmediate(resolve))

		expect(result.stopReason).toBe("toolUse")
		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(runtime.acceptedResponse).toBeDefined()
		expect(records.at(-1)).toMatchObject({ outcome: "tool_use", degradedReason: "panel_unavailable" })
	})

	it("returns the synthesis summary as the public message when the lead produced no prose", async () => {
		const { root } = await fixture()
		const runtime = await stageLeadCandidate(root)
		const driver = createModelDriver({
			leadText: "",
			synthesisSummary: "Rewrote file.txt to satisfy the requested change.",
		})

		const result = await runCouncil(runtime, driver.completeModel).result()
		await new Promise((resolve) => setImmediate(resolve))
		await new Promise((resolve) => setImmediate(resolve))

		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(runtime.acceptedResponse).toBe("Rewrote file.txt to satisfy the requested change.")
		expect(runtime.acceptedResponse).not.toBe("Candidate patch staged for review.")
	})

	it("applies the patch when synthesis omits the summary field entirely", async () => {
		const { root } = await fixture()
		const runtime = await stageLeadCandidate(root)
		const driver = createModelDriver({ omitSynthesisSummary: true })

		const result = await runCouncil(runtime, driver.completeModel).result()

		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
	})

	it("derives the public message from the applied change set when the lead has no prose and synthesis omits a summary", async () => {
		const { root } = await fixture()
		const runtime = await stageLeadCandidate(root)
		const driver = createModelDriver({ leadText: "", synthesisSummary: "" })

		const result = await runCouncil(runtime, driver.completeModel).result()

		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(runtime.acceptedResponse).toBe("Updated file.txt.")
		expect(runtime.acceptedResponse).not.toBe("Candidate patch staged for review.")
	})

	it("applies the patch when the fast preset's combined stage omits the summary field", async () => {
		const { root } = await fixture()
		const runtime = await stageLeadCandidate(root)
		const driver = createModelDriver({ omitSynthesisSummary: true })
		const fastModel: Model<Api> = { ...councilModel, id: "council-fast" }

		const stream = createCouncilStream({
			config,
			getModelRegistry: () => modelRegistry,
			completeModel: driver.completeModel,
			transaction: runtime,
			shouldReviewTurn: () => true,
		})(fastModel, {
			messages: [{ role: "user", content: "Make the requested change.", timestamp: 1 }],
			tools: [
				{ name: "write", description: "Write a file", parameters: { type: "object" } },
				{ name: "bash", description: "Run a shell command", parameters: { type: "object" } },
			],
		})
		const result = await stream.result()

		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
	})

	it("discards a partially staged patch when the stage limit fails", async () => {
		const { root } = await fixture()
		const runtime = await stageLeadCandidate(root)
		const driver = createModelDriver({ synthesisContent: "x\n".repeat(12_001) })

		const result = await runCouncil(runtime, driver.completeModel).result()

		expect(result.stopReason).toBe("error")
		expect(runtime.hasStagedChanges).toBe(false)
		expect(runtime.state).toBe("discarded")
	})

	it("uses one physical call and streams a text-only turn", async () => {
		const model = {
			id: "council",
			name: "Council",
			api: "kimchi-council",
			provider: "kimchi",
			baseUrl: "http://localhost.invalid",
			reasoning: false,
			input: ["text"] as const,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262_144,
			maxTokens: 32_768,
		} satisfies Model<Api>
		const events: string[] = []
		const completeModel = vi.fn(
			async (
				physical: Model<Api>,
				_context: Context,
				_options?: SimpleStreamOptions,
				onTextDelta?: (delta: string, fullText: string) => void,
			): Promise<AssistantMessage> => {
				onTextDelta?.("Hello", "Hello")
				return response(physical, "Hello")
			},
		)
		const stream = createCouncilStream({
			config,
			getModelRegistry: () => modelRegistry,
			completeModel,
			shouldReviewTurn: () => false,
		})(model, { messages: [{ role: "user", content: "Say hello", timestamp: 1 }] })
		const drain = (async () => {
			for await (const event of stream) events.push(event.type === "text_delta" ? event.delta : event.type)
		})()

		expect(await stream.result()).toMatchObject({ content: [{ type: "text", text: "Hello" }], stopReason: "stop" })
		await drain
		expect(completeModel).toHaveBeenCalledTimes(1)
		expect(events).toEqual(["start", "text_start", "Hello", "text_end", "done"])
	})

	it("finishes cleanly with no apply call when synthesis proposes a no-op patch", async () => {
		const { root, file } = await fixture()
		const runtime = await stageLeadCandidate(root)
		const driver = createModelDriver({ synthesisContent: "before\n" })
		const records: CouncilRunRecord[] = []

		const result = await runCouncil(runtime, driver.completeModel, undefined, config, (record) =>
			records.push(record),
		).result()
		await new Promise((resolve) => setImmediate(resolve))
		await new Promise((resolve) => setImmediate(resolve))

		expect(result.stopReason).toBe("stop")
		expect(result.content.some((block) => block.type === "toolCall")).toBe(false)
		expect(await readFile(file, "utf8")).toBe("before\n")
		expect(runtime.state).toBe("discarded")
		expect(records.at(-1)).toMatchObject({ outcome: "accepted", degradedReason: "no_changes_needed" })
	})

	it("finishes cleanly with no apply call when the panel_unavailable fallback patch is a no-op", async () => {
		const { root, file } = await fixture()
		const matchedContent = Array.from({ length: 12 }, (_, index) => `identical content ${index}\n`).join("")
		const runtime = await stageLeadCandidate(root, matchedContent)
		await writeFile(file, matchedContent)
		const driver = createModelDriver({ invalidSolvers: ["solver-a", "solver-b"] })
		const records: CouncilRunRecord[] = []

		const result = await runCouncil(runtime, driver.completeModel, undefined, config, (record) =>
			records.push(record),
		).result()
		await new Promise((resolve) => setImmediate(resolve))
		await new Promise((resolve) => setImmediate(resolve))

		expect(result.stopReason).toBe("stop")
		expect(result.content.some((block) => block.type === "toolCall")).toBe(false)
		expect(await readFile(file, "utf8")).toBe(matchedContent)
		expect(runtime.state).toBe("discarded")
		expect(records.at(-1)).toMatchObject({ outcome: "accepted", degradedReason: "no_changes_needed" })
	})

	it("still promotes a tiny real diff directly without opening the panel", async () => {
		const { root } = await fixture()
		const runtime = await stageLeadCandidate(root, "before\nafter\n")
		const driver = createModelDriver()

		const result = await runCouncil(runtime, driver.completeModel).result()

		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(
			driver.completeModel.mock.calls.some(([_, context]) => context.systemPrompt?.includes("Council solver")),
		).toBe(false)
		expect(runtime.state).toBe("accepted")
	})

	it("rolls back after a failed post-apply check", async () => {
		const { root, file } = await fixture()
		const runtime = await stageLeadCandidate(root)
		const driver = createModelDriver()
		const result = await runCouncil(runtime, driver.completeModel).result()
		const applyCall = result.content[0]
		if (applyCall?.type !== "toolCall") throw new Error("missing apply request")
		await runtime.apply({
			transactionId: String(applyCall.arguments.transaction_id),
			patchSha256: String(applyCall.arguments.patch_sha256),
		})
		await runtime.recordPostApplyCheck("package.test", "package.test", false)

		const check = await runtime.preparePostApplyCheck()
		if (!check) throw new Error("missing post-apply check")
		await runtime.recordPostApplyCheck("bash", check.id, false)
		const rollback = runtime.settlementRequest("rollback")
		if (!rollback) throw new Error("missing rollback request")
		await runtime.settle(rollback)

		expect(runtime.state).toBe("rolled_back")
		expect(await readFile(file, "utf8")).toBe("before\n")
	})
})
