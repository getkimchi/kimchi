import type { AssistantMessage, Usage } from "@earendil-works/pi-ai"
import { describe, expect, it, vi } from "vitest"
import { type CouncilRunContext, CouncilSessionCache } from "./run-context.js"
import { type CouncilStageRuntime, RepairBudget, runStructuredStage } from "./stage-runner.js"

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function message(text: string, modelRef = "physical/primary"): AssistantMessage {
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

/**
 * Builds a stage runtime whose clock is driven by `clock.value` instead of the real wall clock, so
 * a test can simulate time elapsing during an async invocation deterministically.
 */
function harness(clock: { value: number }) {
	vi.spyOn(Date, "now").mockImplementation(() => clock.value)
	const markStageError = vi.fn()
	const startStage = vi.fn()
	const completeStage = vi.fn()
	const failStage = vi.fn()
	const cache = new CouncilSessionCache()
	const run = { throwIfAborted: vi.fn() } as unknown as CouncilRunContext
	const rt: CouncilStageRuntime = {
		run,
		cache,
		repairBudget: new RepairBudget(),
		maxStructuredBytes: 1_000_000,
		invoke: vi.fn(async () => {
			// Simulate the repair call itself consuming all remaining time in the budget.
			clock.value += 10_000
			return message("repaired but still invalid")
		}),
		invokePhysical: vi.fn(async (_stage, pool: { primary: string; fallbacks: string[] }) => ({
			message: message("primary output"),
			model: {} as never,
			modelRef: pool.primary,
			attempts: 1,
		})),
		structuredText: vi.fn((_stage, msg: AssistantMessage) =>
			msg.content[0]?.type === "text" ? msg.content[0].text : "",
		),
		markStageError,
		startStage,
		completeStage,
		failStage,
		rethrowTerminalFailure: vi.fn(),
		pushStage: vi.fn(),
	}
	return { rt, markStageError, failStage, startStage, completeStage }
}

describe("runStructuredStage fallback-deadline exhaustion", () => {
	it("marks the stage as timed out and throws the configured message", async () => {
		const clock = { value: 0 }
		const { rt, markStageError, failStage } = harness(clock)

		await expect(
			runStructuredStage(rt, {
				stage: "analyst",
				pool: { primary: "physical/primary", fallbacks: ["physical/fallback"] },
				schema: "schema-v1",
				maxTokens: 100,
				repairMaxTokens: 100,
				// The repair invocation (mocked above) advances the clock by 10s past this deadline,
				// so by the time we look for a fallback model the budget is already exhausted.
				deadline: 5_000,
				cacheKeyFor: (modelId) => ({
					patchHash: "p",
					baseSnapshotHash: "b",
					objectiveHash: "o",
					constraintsHash: "c",
					evidenceHash: "e",
					role: "analyst",
					modelId,
					promptVersion: "v",
					schemaVersion: "s",
				}),
				cacheWriteValidate: () => true,
				prepareContext: () => ({ context: { messages: [] }, requestedMaxTokens: 100 }),
				parse: () => {
					throw new Error("always invalid")
				},
				fallbackDeadlineExceededMessage: "analysis deadline exceeded",
			}),
		).rejects.toThrow("analysis deadline exceeded")

		expect(markStageError).toHaveBeenCalledWith("analyst", "timeout")
		expect(failStage).toHaveBeenCalledWith("analyst", "timed_out")
	})

	it("rethrows the original failure without marking a timeout when fallbackDeadlineExceededMessage is unset", async () => {
		const clock = { value: 0 }
		const { rt, markStageError, failStage } = harness(clock)

		await expect(
			runStructuredStage(rt, {
				stage: "solver",
				pool: { primary: "physical/primary", fallbacks: ["physical/fallback"] },
				schema: "schema-v1",
				maxTokens: 100,
				repairMaxTokens: 100,
				deadline: 5_000,
				cacheKeyFor: (modelId) => ({
					patchHash: "p",
					baseSnapshotHash: "b",
					objectiveHash: "o",
					constraintsHash: "c",
					evidenceHash: "e",
					role: "solver",
					modelId,
					promptVersion: "v",
					schemaVersion: "s",
				}),
				cacheWriteValidate: () => true,
				prepareContext: () => ({ context: { messages: [] }, requestedMaxTokens: 100 }),
				parse: () => {
					throw new Error("always invalid")
				},
			}),
		).rejects.toThrow("always invalid")

		expect(markStageError).not.toHaveBeenCalledWith("solver", "timeout")
		expect(failStage).not.toHaveBeenCalledWith("solver", "timed_out")
	})
})
