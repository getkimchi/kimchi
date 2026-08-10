import { describe, expect, it, vi } from "vitest"
import {
	candidateText,
	fixture,
	redactObjectStringsMock,
	transactionRuntime,
} from "./coordinator-transaction-fixtures.js"
import {
	COUNCIL_FAILURE,
	councilModel,
	createAlwaysReviewCouncilStream,
	modelRegistry,
	response,
	TEST_COUNCIL_CONFIG,
} from "./runtime-test-harness.js"
import type { CouncilRunRecord } from "./types.js"

async function stagedTransaction() {
	const { root } = await fixture()
	const transaction = transactionRuntime(root)
	const body = (name: string) =>
		Array.from(
			{ length: 12 },
			(_, index) => `export const ${name}${index} = "${candidateText.trim()} ${index}"\n`,
		).join("")
	await transaction.ensure().stageWrite("src/alpha.ts", body("alpha"))
	await transaction.ensure().stageWrite("src/beta.ts", body("beta"))
	return transaction
}

describe("runtime redaction", () => {
	it("fails closed when evidence redaction fails", async () => {
		redactObjectStringsMock.mockRejectedValueOnce(new Error("redactor unavailable"))
		const transaction = await stagedTransaction()
		let record: CouncilRunRecord | undefined
		const completeModel = vi.fn(async (model: Parameters<typeof response>[0]) => response(model, "private"))
		const stream = createAlwaysReviewCouncilStream({
			config: TEST_COUNCIL_CONFIG,
			getModelRegistry: () => modelRegistry,
			completeModel,
			transaction,
			recordRun: (value) => {
				record = value
			},
		})(councilModel, { messages: [{ role: "user", content: "secret", timestamp: 1 }] })

		const result = await stream.result()
		expect(result).toMatchObject(COUNCIL_FAILURE)
		expect(completeModel).toHaveBeenCalledTimes(1)
		expect(redactObjectStringsMock).toHaveBeenCalledWith(expect.anything(), { failClosed: true })
		await new Promise((resolve) => setImmediate(resolve))
		expect(record?.outcome).toBe("error")
	})

	it("fails with the shared deadline while redaction is pending", async () => {
		redactObjectStringsMock.mockImplementationOnce(() => new Promise<never>(() => {}))
		const transaction = await stagedTransaction()
		const completeModel = vi.fn(async (model: Parameters<typeof response>[0]) => response(model, "private"))
		const stream = createAlwaysReviewCouncilStream({
			config: { ...TEST_COUNCIL_CONFIG, overallTimeoutMs: 10 },
			getModelRegistry: () => modelRegistry,
			completeModel,
			transaction,
		})(councilModel, { messages: [{ role: "user", content: "secret", timestamp: 1 }] })

		const result = await Promise.race([
			stream.result(),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("redaction deadline test timed out")), 100)),
		])
		expect(result).toMatchObject({ stopReason: "error", errorMessage: "Council whole-run deadline exceeded" })
	})

	it("aborts while redaction is pending", async () => {
		let resolveStarted!: () => void
		const started = new Promise<void>((resolve) => {
			resolveStarted = resolve
		})
		redactObjectStringsMock.mockImplementationOnce(() => {
			resolveStarted()
			return new Promise<never>(() => {})
		})
		const transaction = await stagedTransaction()
		const controller = new AbortController()
		const completeModel = vi.fn(async (model: Parameters<typeof response>[0]) => response(model, "private"))
		const stream = createAlwaysReviewCouncilStream({
			config: TEST_COUNCIL_CONFIG,
			getModelRegistry: () => modelRegistry,
			completeModel,
			transaction,
		})(councilModel, { messages: [{ role: "user", content: "secret", timestamp: 1 }] }, { signal: controller.signal })

		await started
		controller.abort()
		expect(await stream.result()).toMatchObject({ stopReason: "aborted", errorMessage: "Council request aborted" })
	})
})
