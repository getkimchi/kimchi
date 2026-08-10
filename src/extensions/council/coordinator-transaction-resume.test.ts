import { readFile, writeFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import {
	candidateText,
	config,
	createModelDriver,
	fixture,
	promotionRequestFromToolCall,
	runCouncil,
	transactionRuntime,
} from "./coordinator-transaction-fixtures.js"
import { CouncilTransactionRuntime, MAX_TRANSACTION_REEMISSIONS } from "./transaction-runtime.js"
import { COUNCIL_APPLY_TOOL, COUNCIL_SETTLE_TOOL } from "./transaction-tools.js"
import type { CouncilRunRecord } from "./types.js"

describe("coordinator-transaction-resume", () => {
	it("clamps deterministic validation to the remaining whole-run deadline", async () => {
		const { root } = await fixture()
		const runtime = transactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", candidateText)
		const driver = createModelDriver()
		const accepted = await runCouncil(runtime, driver.completeModel).result()
		const acceptedCall = accepted.content[0]
		if (acceptedCall?.type !== "toolCall") throw new Error("missing apply tool call")
		await runtime.apply(promotionRequestFromToolCall(acceptedCall))
		const saved = runtime.savedRunBudget
		if (!saved) throw new Error("missing saved Council run budget")
		runtime.saveRunBudget({ ...saved, deadlineAt: Date.now() + 1_500 })

		const validation = await runCouncil(runtime, driver.completeModel).result()
		const call = validation.content[0]
		const timeout =
			call?.type === "toolCall" && typeof call.arguments.timeout === "number" ? call.arguments.timeout : undefined

		expect(timeout).toBeGreaterThan(0)
		expect(timeout).toBeLessThanOrEqual(1.5)
	})
	it("rolls back instead of validating after the whole-run deadline", async () => {
		const { root, file } = await fixture()
		const runtime = transactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", candidateText)
		const driver = createModelDriver()
		const accepted = await runCouncil(runtime, driver.completeModel).result()
		const acceptedCall = accepted.content[0]
		if (acceptedCall?.type !== "toolCall") throw new Error("missing apply tool call")
		await runtime.apply(promotionRequestFromToolCall(acceptedCall))
		const saved = runtime.savedRunBudget
		if (!saved) throw new Error("missing saved Council run budget")
		runtime.saveRunBudget({ ...saved, deadlineAt: Date.now() - 1 })

		const result = await runCouncil(runtime, driver.completeModel).result()

		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "Council whole-run deadline exceeded",
		})
		expect(runtime.state).toBe("rolled_back")
		expect(await readFile(file, "utf8")).toBe("before\n")
	})
	it("applies and settles a candidate without deterministic validation checks", async () => {
		const { root, file } = await fixture()
		const runtime = new CouncilTransactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", "candidate\n")
		const driver = createModelDriver()

		const result = await runCouncil(runtime, driver.completeModel).result()
		const call = result.content[0]

		expect(call).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(driver.completeModel.mock.calls.map(([model]) => model.id)).toEqual(["lead"])
		expect(runtime.state).toBe("accepted")
		expect(await readFile(file, "utf8")).toBe("before\n")
		if (call?.type !== "toolCall") throw new Error("missing apply tool call")
		await runtime.apply(promotionRequestFromToolCall(call))
		const settlement = runtime.settlementRequest("finalize")
		if (!settlement) throw new Error("missing settlement capability")
		await runtime.settle(settlement)

		let record: CouncilRunRecord | undefined
		const final = await runCouncil(runtime, driver.completeModel, undefined, config, (value) => {
			record = value
		}).result()
		await new Promise<void>((resolve) => setImmediate(resolve))

		expect(final.content).toEqual([
			{
				type: "text",
				text: "Lead candidate summary.\n\nCouncil applied the patch without deterministic validation checks because none were available.",
			},
		])
		expect(record).toMatchObject({ outcome: "degraded", degradedReason: "no_validation_checks" })
		expect(await readFile(file, "utf8")).toBe("candidate\n")
	})
	it("re-emits the same finalize settlement tool call when it was emitted but never executed, then rolls back once the bound is exhausted", async () => {
		const { root, file } = await fixture()
		const runtime = transactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", candidateText)
		const candidate = runtime.propose()
		runtime.setRequiredPostApplyChecks(["package.test"])
		await runtime.apply(runtime.accept(candidate.patchSha256))
		const check = await runtime.preparePostApplyCheck()
		if (!check) throw new Error("missing validation check")
		await runtime.recordPostApplyCheck("bash", check.id, true)
		const driver = createModelDriver()

		const first = await runCouncil(runtime, driver.completeModel).result()
		expect(first.content[0]).toMatchObject({
			type: "toolCall",
			name: COUNCIL_SETTLE_TOOL,
			arguments: expect.objectContaining({ action: "finalize" }),
		})
		expect(await readFile(file, "utf8")).toBe(candidateText)

		// The host never executed the settle tool call; every re-entry re-emits the identical
		// finalize request instead of rolling back, up to the re-emission bound.
		for (let attempt = 0; attempt < MAX_TRANSACTION_REEMISSIONS; attempt++) {
			const reemitted = await runCouncil(runtime, driver.completeModel).result()
			expect(reemitted.content[0]).toMatchObject({
				type: "toolCall",
				name: COUNCIL_SETTLE_TOOL,
				arguments: first.content[0]?.type === "toolCall" ? first.content[0].arguments : undefined,
			})
			expect(runtime.state).toBe("post_apply_checks")
			expect(await readFile(file, "utf8")).toBe(candidateText)
		}
		expect(driver.completeModel).not.toHaveBeenCalled()

		// Only finalize gives up once exhausted; giving up here still means the safety action
		// (rollback) runs directly rather than leaving the applied-but-unvalidated patch in place.
		const final = await runCouncil(runtime, driver.completeModel).result()
		expect(final.stopReason).toBe("error")
		expect(final.errorMessage).toContain("rolled back")
		expect(runtime.state).toBe("rolled_back")
		expect(await readFile(file, "utf8")).toBe("before\n")
		expect(driver.completeModel).not.toHaveBeenCalled()
	})
	it("keeps re-emitting a rollback settlement well past the finalize re-emission bound, and still delivers it", async () => {
		const { root, file } = await fixture()
		const runtime = transactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", candidateText)
		const candidate = runtime.propose()
		runtime.setRequiredPostApplyChecks(["package.test"])
		await runtime.apply(runtime.accept(candidate.patchSha256))
		const check = await runtime.preparePostApplyCheck()
		if (!check) throw new Error("missing validation check")
		await runtime.recordPostApplyCheck("bash", check.id, false)
		const driver = createModelDriver()

		const first = await runCouncil(runtime, driver.completeModel).result()
		expect(first.content[0]).toMatchObject({
			type: "toolCall",
			name: COUNCIL_SETTLE_TOOL,
			arguments: expect.objectContaining({ action: "rollback" }),
		})
		expect(await readFile(file, "utf8")).toBe(candidateText)

		// The host never executes the settle tool call. Unlike finalize, rollback is the safety
		// action: it keeps being re-emitted well past what would have exhausted a finalize request,
		// instead of giving up and forcing an emergency cleanup.
		let last = first
		for (let attempt = 0; attempt < MAX_TRANSACTION_REEMISSIONS * 3; attempt++) {
			last = await runCouncil(runtime, driver.completeModel).result()
			expect(last.content[0]).toMatchObject({
				type: "toolCall",
				name: COUNCIL_SETTLE_TOOL,
				arguments: first.content[0]?.type === "toolCall" ? first.content[0].arguments : undefined,
			})
			expect(runtime.state).toBe("post_apply_checks")
			expect(await readFile(file, "utf8")).toBe(candidateText)
		}
		expect(driver.completeModel).not.toHaveBeenCalled()

		// The host finally executes the re-emitted request: the workspace ends up rolled back.
		const call = last.content[0]
		if (call?.type !== "toolCall") throw new Error("missing settle tool call")
		await runtime.settle({
			transactionId: call.arguments.transaction_id as string,
			patchSha256: call.arguments.patch_sha256 as string,
			action: call.arguments.action as "finalize" | "rollback",
		})

		expect(runtime.state).toBe("rolled_back")
		expect(await readFile(file, "utf8")).toBe("before\n")
	})
	it("re-emits the same apply tool call when it was emitted but never executed, then discards once the bound is exhausted", async () => {
		const { root, file } = await fixture()
		const runtime = transactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", candidateText)
		const candidate = runtime.propose()
		runtime.accept(candidate.patchSha256)
		const driver = createModelDriver()

		// runtime.accept() above stands in for the coordinator's own promoteCandidate emitting the
		// apply tool call on the original (non-resumed) turn; this first runCouncil call is already
		// the first resumed re-entry after the host failed to execute it, so it consumes the first
		// slot of the re-emission bound.
		const first = await runCouncil(runtime, driver.completeModel).result()
		expect(first.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(runtime.state).toBe("accepted")
		expect(await readFile(file, "utf8")).toBe("before\n")

		// The host never executed the apply tool call; every further re-entry re-emits the identical
		// request instead of discarding the transaction, up to the re-emission bound.
		for (let attempt = 1; attempt < MAX_TRANSACTION_REEMISSIONS; attempt++) {
			const reemitted = await runCouncil(runtime, driver.completeModel).result()
			expect(reemitted.content[0]).toMatchObject({
				type: "toolCall",
				name: COUNCIL_APPLY_TOOL,
				arguments: first.content[0]?.type === "toolCall" ? first.content[0].arguments : undefined,
			})
			expect(runtime.state).toBe("accepted")
			expect(await readFile(file, "utf8")).toBe("before\n")
		}
		expect(driver.completeModel).not.toHaveBeenCalled()

		const final = await runCouncil(runtime, driver.completeModel).result()
		expect(final.stopReason).toBe("error")
		expect(final.errorMessage).toContain("discarded")
		expect(runtime.state).toBe("discarded")
		expect(await readFile(file, "utf8")).toBe("before\n")
		expect(driver.completeModel).not.toHaveBeenCalled()
	})
	it("fails closed on base drift even when the apply request was re-emitted after resume", async () => {
		const { root, file } = await fixture()
		const runtime = transactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", candidateText)
		const candidate = runtime.propose()
		runtime.accept(candidate.patchSha256)
		const driver = createModelDriver()

		const first = await runCouncil(runtime, driver.completeModel).result()
		expect(first.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })

		// The host never executed the apply tool call, so the transaction resumes and re-emits it.
		const reemitted = await runCouncil(runtime, driver.completeModel).result()
		const reemittedCall = reemitted.content[0]
		if (reemittedCall?.type !== "toolCall") throw new Error("missing re-emitted apply tool call")

		// The base bytes drift underneath the accepted transaction before the re-emitted request is
		// ever executed.
		await writeFile(file, "drifted\n")

		await expect(runtime.apply(promotionRequestFromToolCall(reemittedCall))).rejects.toThrow()
		expect(await readFile(file, "utf8")).toBe("drifted\n")
	})
})
