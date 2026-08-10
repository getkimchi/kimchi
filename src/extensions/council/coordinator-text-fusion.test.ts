import { describe, expect, it } from "vitest"
import { createCouncilStream } from "./coordinator.js"
import {
	cleanTextAnalysis,
	config,
	councilModel,
	createTextModelDriver,
	modelRegistry,
	runTextCouncil,
	stageInput,
	substantialAnswer,
} from "./coordinator-text-fusion-fixtures.js"
import { RunFailure } from "./run-context.js"
import type { CouncilRunRecord } from "./schemas.js"

const SOLVER_PROMPT = "You are a Council solver. Answer the objective"
const ANALYST_PROMPT = "You are the Council analyst. Compare the independently generated answers"
const LEAD_SYNTHESIS_PROMPT = "You are the Council lead. Write the final answer"

describe("coordinator text fusion", () => {
	it("freezes one packet, counts the lead as member one, and isolates concurrent solvers", async () => {
		const driver = createTextModelDriver()
		const records: CouncilRunRecord[] = []

		const result = await runTextCouncil(driver.completeModel, undefined, config, (record) =>
			records.push(record),
		).result()

		const solverCalls = driver.completeModel.mock.calls.filter(([_, context]) =>
			context.systemPrompt?.includes(SOLVER_PROMPT),
		)
		const solverPackets = solverCalls.map(([_, context]) => stageInput(context))
		const analystCall = driver.completeModel.mock.calls.find(([_, context]) =>
			context.systemPrompt?.includes(ANALYST_PROMPT),
		)
		if (!analystCall) throw new Error("missing analyst call")
		const comparison = stageInput(analystCall[1])
		const solutions = comparison.solutions as Array<{ label: string; text: string }>

		expect(result.stopReason).toBe("stop")
		expect(result.content).toEqual([{ type: "text", text: expect.any(String) }])
		expect(solverCalls).toHaveLength(2)
		expect(solverPackets[0]).toEqual(solverPackets[1])
		expect(JSON.stringify(solverPackets)).not.toContain("solver-a paragraph")
		expect(JSON.stringify(solverPackets)).not.toContain("solver-b paragraph")
		expect(solutions).toHaveLength(3)
		expect(solutions.map(({ label }) => label)).toEqual(["Solution A", "Solution B", "Solution C"])
		expect(solutions.some(({ text }) => text.includes("lead paragraph"))).toBe(true)
		expect(JSON.stringify(result.content)).not.toContain("solver-a paragraph")
		expect(records.at(-1)).toMatchObject({ outcome: "accepted" })
		expect(records.at(-1)?.transaction).toBeUndefined()
	})

	it("returns the synthesized answer, not the lead's own draft", async () => {
		const finalAnswer = "Use a write-through cache with a short TTL and stampede protection."
		const driver = createTextModelDriver({ synthesisAnswer: finalAnswer })

		const result = await runTextCouncil(driver.completeModel).result()

		expect(result.content).toEqual([{ type: "text", text: finalAnswer }])
	})

	it("drops a solver that fails after repair and compares the remaining panel", async () => {
		const driver = createTextModelDriver({ invalidSolvers: ["solver-a"] })

		await runTextCouncil(driver.completeModel).result()

		const analystCall = driver.completeModel.mock.calls.find(([_, context]) =>
			context.systemPrompt?.includes(ANALYST_PROMPT),
		)
		if (!analystCall) throw new Error("missing analyst call")
		expect((stageInput(analystCall[1]).solutions as unknown[]).length).toBe(2)
		expect(
			driver.completeModel.mock.calls.filter(([_, context]) =>
				context.systemPrompt?.includes("Repair the supplied object"),
			),
		).toHaveLength(1)
	})

	it("skips deliberation entirely and costs one call for a trivial/short text turn", async () => {
		const driver = createTextModelDriver({ leadText: "Hello" })
		const records: CouncilRunRecord[] = []

		const result = await runTextCouncil(
			driver.completeModel,
			undefined,
			config,
			(record) => records.push(record),
			"hi",
		).result()

		expect(result.content).toEqual([{ type: "text", text: "Hello" }])
		expect(driver.completeModel).toHaveBeenCalledTimes(1)
		expect(records.at(-1)).toMatchObject({ outcome: "accepted" })
		// Only the lead itself ran: no solver, analyst, or synthesis stage.
		expect(records.at(-1)?.stages.map((stage) => stage.stage)).toEqual(["lead"])
	})

	it("streams a trivial text turn live, exactly as an ordinary direct answer", async () => {
		const driver = createTextModelDriver({ leadText: "Hello" })
		const events: string[] = []
		const stream = createCouncilStream({
			config,
			getModelRegistry: () => modelRegistry,
			completeModel: async (model, context, opts, onTextDelta) => {
				onTextDelta?.("Hello", "Hello")
				return driver.completeModel(model, context, opts)
			},
			shouldReviewTurn: () => false,
		})(councilModel, { messages: [{ role: "user", content: "Say hello", timestamp: 1 }] })
		const drain = (async () => {
			for await (const event of stream) events.push(event.type === "text_delta" ? event.delta : event.type)
		})()

		expect(await stream.result()).toMatchObject({ content: [{ type: "text", text: "Hello" }], stopReason: "stop" })
		await drain
		expect(events).toEqual(["start", "text_start", "Hello", "text_end", "done"])
	})

	it("buffers a deliberated turn instead of streaming the lead's draft, then delivers the synthesis in one piece", async () => {
		const finalAnswer = "Use a write-through cache with a short TTL and stampede protection for the payments service."
		const driver = createTextModelDriver({ synthesisAnswer: finalAnswer })
		const events: string[] = []
		const stream = runTextCouncil(driver.completeModel)
		const drain = (async () => {
			for await (const event of stream) events.push(event.type === "text_delta" ? event.delta : event.type)
		})()

		const result = await stream.result()
		await drain

		expect(result.content).toEqual([{ type: "text", text: finalAnswer }])
		// Exactly one text_delta, carrying the whole synthesized answer: the lead's draft was never
		// streamed live and then discarded.
		expect(events).toEqual(["start", "text_start", finalAnswer, "text_end", "done"])
	})

	it("degrades to the lead's own answer, never an error, when the analyst stage fails", async () => {
		const driver = createTextModelDriver({ leadText: substantialAnswer("lead") })
		driver.completeModel.mockImplementation(async (model, context) => {
			const systemPrompt = context.systemPrompt ?? ""
			if (systemPrompt.includes(ANALYST_PROMPT)) throw new Error("analyst provider failure")
			if (systemPrompt.includes(SOLVER_PROMPT)) return createTextModelDriver().completeModel(model, context)
			return createTextModelDriver({ leadText: substantialAnswer("lead") }).completeModel(model, context)
		})
		const records: CouncilRunRecord[] = []

		const result = await runTextCouncil(driver.completeModel, undefined, config, (record) =>
			records.push(record),
		).result()
		await new Promise((resolve) => setImmediate(resolve))
		await new Promise((resolve) => setImmediate(resolve))

		expect(result.stopReason).toBe("stop")
		expect(result.content).toEqual([{ type: "text", text: substantialAnswer("lead") }])
		expect(records.at(-1)).toMatchObject({ outcome: "degraded", degradedReason: "analyst_failed" })
	})

	it("degrades to the lead's own answer, never an error, when the synthesis stage fails", async () => {
		const driver = createTextModelDriver({ leadText: substantialAnswer("lead") })
		driver.completeModel.mockImplementation(async (model, context) => {
			const systemPrompt = context.systemPrompt ?? ""
			if (systemPrompt.includes(LEAD_SYNTHESIS_PROMPT)) throw new Error("synthesis provider failure")
			if (systemPrompt.includes(SOLVER_PROMPT) || systemPrompt.includes(ANALYST_PROMPT)) {
				return createTextModelDriver().completeModel(model, context)
			}
			return createTextModelDriver({ leadText: substantialAnswer("lead") }).completeModel(model, context)
		})
		const records: CouncilRunRecord[] = []

		const result = await runTextCouncil(driver.completeModel, undefined, config, (record) =>
			records.push(record),
		).result()
		await new Promise((resolve) => setImmediate(resolve))
		await new Promise((resolve) => setImmediate(resolve))

		expect(result.stopReason).toBe("stop")
		expect(result.content).toEqual([{ type: "text", text: substantialAnswer("lead") }])
		expect(records.at(-1)).toMatchObject({ outcome: "degraded", degradedReason: "synthesis_failed" })
	})

	it("degrades to the lead's own answer when the whole-run deadline is exceeded during the panel", async () => {
		const driver = createTextModelDriver({ leadText: substantialAnswer("lead") })
		driver.completeModel.mockImplementation(async (model, context) => {
			const systemPrompt = context.systemPrompt ?? ""
			if (systemPrompt.includes(SOLVER_PROMPT))
				throw new RunFailure("deadline_exceeded", "Council whole-run deadline exceeded")
			return createTextModelDriver({ leadText: substantialAnswer("lead") }).completeModel(model, context)
		})
		const records: CouncilRunRecord[] = []

		const result = await runTextCouncil(driver.completeModel, undefined, config, (record) =>
			records.push(record),
		).result()
		await new Promise((resolve) => setImmediate(resolve))
		await new Promise((resolve) => setImmediate(resolve))

		expect(result.stopReason).toBe("stop")
		expect(result.content).toEqual([{ type: "text", text: substantialAnswer("lead") }])
		expect(records.at(-1)).toMatchObject({ outcome: "degraded", degradedReason: "deadline_exceeded" })
	})

	it("degrades to the lead's own answer when the whole-run budget is exhausted before the panel", async () => {
		const driver = createTextModelDriver({ leadText: substantialAnswer("lead") })
		const tightConfig = { ...config, budget: { ...config.budget, maxLogicalCalls: 1 } }
		const records: CouncilRunRecord[] = []

		const result = await runTextCouncil(driver.completeModel, undefined, tightConfig, (record) =>
			records.push(record),
		).result()
		await new Promise((resolve) => setImmediate(resolve))
		await new Promise((resolve) => setImmediate(resolve))

		expect(driver.completeModel.mock.calls.some(([_, context]) => context.systemPrompt?.includes(SOLVER_PROMPT))).toBe(
			false,
		)
		expect(result.stopReason).toBe("stop")
		expect(result.content).toEqual([{ type: "text", text: substantialAnswer("lead") }])
		expect(records.at(-1)).toMatchObject({ outcome: "degraded", degradedReason: "budget_exceeded" })
	})

	it("degrades to the lead's own answer when fewer than two usable answers survive the panel", async () => {
		const driver = createTextModelDriver({
			invalidSolvers: ["solver-a", "solver-b"],
			leadText: substantialAnswer("lead"),
		})
		const records: CouncilRunRecord[] = []

		const result = await runTextCouncil(driver.completeModel, undefined, config, (record) =>
			records.push(record),
		).result()
		await new Promise((resolve) => setImmediate(resolve))
		await new Promise((resolve) => setImmediate(resolve))

		expect(result.stopReason).toBe("stop")
		expect(result.content).toEqual([{ type: "text", text: substantialAnswer("lead") }])
		expect(driver.completeModel.mock.calls.some(([_, context]) => context.systemPrompt?.includes(ANALYST_PROMPT))).toBe(
			false,
		)
		expect(records.at(-1)).toMatchObject({ outcome: "degraded", degradedReason: "panel_unavailable" })
	})

	it("opens no transaction and runs no validation check, even when the analyst supplies required_checks", async () => {
		const driver = createTextModelDriver({
			analysis: { ...cleanTextAnalysis, required_checks: ["package.test"] },
		})
		const records: CouncilRunRecord[] = []

		const result = await runTextCouncil(driver.completeModel, undefined, config, (record) =>
			records.push(record),
		).result()

		expect(result.content.every((block) => block.type === "text")).toBe(true)
		expect(records.at(-1)?.transaction).toBeUndefined()
	})
})
