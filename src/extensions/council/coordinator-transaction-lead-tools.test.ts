import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, ToolCall } from "@earendil-works/pi-ai"
import { describe, expect, it, vi } from "vitest"
import {
	candidateText,
	config,
	createModelDriver,
	fixture,
	response,
	runCouncil,
	toolResponse,
	transactionRuntime,
} from "./coordinator-transaction-fixtures.js"
import { COUNCIL_APPLY_TOOL, COUNCIL_CHECK_TOOL } from "./transaction-tools.js"
import type { CouncilConfig } from "./types.js"

describe("coordinator-transaction-lead-tools", () => {
	it.skip("enforces one cumulative call budget across successive tool rounds", async () => {
		const { root } = await fixture()
		const runtime = transactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", candidateText)
		const driver = createModelDriver()
		const constrained: CouncilConfig = {
			...config,
			budget: { ...config.budget, maxLogicalCalls: 5, maxPhysicalAttempts: 5 },
		}

		const first = await runCouncil(runtime, driver.completeModel, undefined, constrained).result()
		await new Promise((resolve) => setImmediate(resolve))
		expect(first.stopReason).toBe("toolUse")
		expect(driver.completeModel).toHaveBeenCalledTimes(5)
		expect(runtime.savedRunBudget?.snapshot.logicalCalls).toBe(5)
	})
	it("keeps transaction tools but hides bash after a staged edit", async () => {
		const { root } = await fixture()
		const runtime = transactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", candidateText)
		const driver = createModelDriver()
		const completeModel = vi.fn(
			async (model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> => {
				if (model.id === "lead" && context.tools?.length) {
					return toolResponse(model, {
						type: "toolCall",
						id: "lead-follow-up",
						name: "write",
						arguments: { path: "file.txt", content: "candidate follow-up\n" },
					})
				}
				return driver.completeModel(model, context, options)
			},
		)

		const result = await runCouncil(runtime, completeModel).result()

		expect(result).toMatchObject({ stopReason: "toolUse" })
		expect(result.content[0]).toMatchObject({ type: "toolCall", id: "lead-follow-up", name: "write" })
		expect(completeModel).toHaveBeenCalledTimes(1)
		expect(completeModel.mock.calls[0]?.[1].tools).toHaveLength(2)
		expect(completeModel.mock.calls[0]?.[1].tools?.map(({ name }) => name)).toEqual(["write", COUNCIL_CHECK_TOOL])
		expect(completeModel.mock.calls[0]?.[1].systemPrompt).toContain("council_check_candidate")
		expect(runtime.state).toBe("staging")
	})
	it("does not advertise council_check_candidate before anything is staged", async () => {
		const { root } = await fixture()
		const runtime = transactionRuntime(root)
		runtime.ensure()
		const driver = createModelDriver()
		const completeModel = vi.fn(
			async (model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> => {
				if (model.id === "lead" && context.tools?.length) {
					return toolResponse(model, {
						type: "toolCall",
						id: "lead-explore",
						name: "bash",
						arguments: { command: "ls" },
					})
				}
				return driver.completeModel(model, context, options)
			},
		)

		const result = await runCouncil(runtime, completeModel).result()

		expect(result).toMatchObject({ stopReason: "toolUse" })
		expect(completeModel.mock.calls[0]?.[1].tools?.map(({ name }) => name)).toEqual(["write", "bash"])
		expect(completeModel.mock.calls[0]?.[1].systemPrompt).not.toContain("council_check_candidate")
	})
	it("reviews a staged candidate when the lead requests blocked bash validation", async () => {
		const { root } = await fixture()
		const runtime = transactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", candidateText)
		const driver = createModelDriver()
		const blockedValidation: ToolCall = {
			type: "toolCall",
			id: "blocked-validation",
			name: "bash",
			arguments: { command: "node --test" },
		}
		const completeModel = vi.fn(
			async (model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> => {
				if (model.id === "test/lead" && context.tools?.length) {
					return {
						...toolResponse(model, blockedValidation),
						content: [{ type: "text", text: "Implemented the requested change." }, blockedValidation],
					}
				}
				return driver.completeModel(model, context, options)
			},
		)

		const result = await runCouncil(runtime, completeModel).result()

		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(runtime.state).toBe("accepted")
	})
	it("drops an unadvertised lead tool call while nothing is staged and finishes with the accompanying text", async () => {
		const { root } = await fixture()
		const runtime = transactionRuntime(root)
		runtime.ensure()
		const driver = createModelDriver()
		const unadvertisedCall: ToolCall = {
			type: "toolCall",
			id: "unadvertised-check",
			name: COUNCIL_CHECK_TOOL,
			arguments: { check_id: "package.test" },
		}
		const completeModel = vi.fn(
			async (model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> => {
				if (model.id === "lead" && context.tools?.length) {
					return {
						...toolResponse(model, unadvertisedCall),
						content: [{ type: "text", text: "Nothing needs to change here." }, unadvertisedCall],
					}
				}
				return driver.completeModel(model, context, options)
			},
		)

		const result = await runCouncil(runtime, completeModel).result()

		expect(completeModel).toHaveBeenCalledTimes(1)
		expect(result.stopReason).not.toBe("error")
		expect(result.content).toEqual([{ type: "text", text: "Nothing needs to change here." }])
	})
	it("drops an unadvertised lead tool call while changes are staged, matching the pre-existing behaviour", async () => {
		const { root } = await fixture()
		const runtime = transactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", candidateText)
		const driver = createModelDriver()
		const unadvertisedCall: ToolCall = {
			type: "toolCall",
			id: "unadvertised-bash",
			name: "bash",
			arguments: { command: "node --test" },
		}
		let leadCalls = 0
		const completeModel = vi.fn(
			async (model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> => {
				if (model.id === "lead" && context.tools?.length) {
					leadCalls++
					return {
						...toolResponse(model, unadvertisedCall),
						content: [{ type: "text", text: "Implemented the requested change." }, unadvertisedCall],
					}
				}
				return driver.completeModel(model, context, options)
			},
		)

		const result = await runCouncil(runtime, completeModel).result()

		// The unadvertised bash call is dropped exactly as before: the lead is not retried for it, and
		// the staged candidate proceeds through the same review pipeline as a plain-text staged draft.
		expect(leadCalls).toBe(1)
		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(runtime.state).toBe("accepted")
	})
	it.each([
		["blank name", { type: "toolCall" as const, id: "call_1", name: " ", arguments: {} }],
		[
			"array arguments",
			{ type: "toolCall" as const, id: "call_1", name: "write", arguments: [] as unknown as Record<string, unknown> },
		],
		[
			"duplicate ids",
			[
				{ type: "toolCall" as const, id: "call_1", name: "write", arguments: { path: "file.txt", content: "a\n" } },
				{ type: "toolCall" as const, id: "call_1", name: "bash", arguments: { command: "ls" } },
			],
		],
	])("still fails the run when the lead emits a genuinely malformed call (%s)", async (_label, malformed) => {
		const { root } = await fixture()
		const runtime = transactionRuntime(root)
		runtime.ensure()
		const driver = createModelDriver()
		const malformedContent = Array.isArray(malformed) ? malformed : [malformed]
		const completeModel = vi.fn(
			async (model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> => {
				if (model.id === "lead" && context.tools?.length) {
					return { ...toolResponse(model, malformedContent[0]), content: malformedContent }
				}
				return driver.completeModel(model, context, options)
			},
		)

		const result = await runCouncil(runtime, completeModel).result()

		expect(result.stopReason).toBe("error")
	})
	it("retries the lead when filtering removes its only tool call and there is no other text, while nothing is staged", async () => {
		const { root } = await fixture()
		const runtime = transactionRuntime(root)
		runtime.ensure()
		const driver = createModelDriver()
		const unadvertisedCall: ToolCall = {
			type: "toolCall",
			id: "unadvertised-check",
			name: COUNCIL_CHECK_TOOL,
			arguments: { check_id: "package.test" },
		}
		let leadCalls = 0
		const completeModel = vi.fn(
			async (model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> => {
				if (model.id === "lead" && context.tools?.length) {
					leadCalls++
					if (leadCalls === 1) return toolResponse(model, unadvertisedCall)
					expect(context.systemPrompt).toContain("Correct that now.")
					return response(model, "Nothing needs to change here.")
				}
				return driver.completeModel(model, context, options)
			},
		)

		const result = await runCouncil(runtime, completeModel).result()

		expect(leadCalls).toBe(2)
		expect(result.stopReason).toBe("stop")
		expect(result.content).toEqual([{ type: "text", text: "Nothing needs to change here." }])
	})
	it("fails the run once the logical-call budget is exhausted by repeated lead tool rounds", async () => {
		const { root } = await fixture()
		const runtime = transactionRuntime(root)
		runtime.ensure()
		let toolCalls = 0
		const completeModel = vi.fn(
			async (model: Model<Api>, _context: Context, _options?: SimpleStreamOptions): Promise<AssistantMessage> => {
				toolCalls++
				return toolResponse(model, {
					type: "toolCall",
					id: `lead-tool-${toolCalls}`,
					name: "write",
					arguments: { path: "file.txt", content: "candidate\n" },
				})
			},
		)
		const constrained: CouncilConfig = {
			...config,
			budget: { ...config.budget, maxLogicalCalls: 2, maxPhysicalAttempts: 4 },
		}

		for (let round = 0; round < 2; round++) {
			expect((await runCouncil(runtime, completeModel, undefined, constrained).result()).stopReason).toBe("toolUse")
		}
		const result = await runCouncil(runtime, completeModel, undefined, constrained).result()

		expect(result.stopReason).toBe("error")
	})
})
