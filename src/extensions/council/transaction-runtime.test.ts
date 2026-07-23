import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { CouncilTransactionRuntime } from "./transaction-runtime.js"

const roots: string[] = []

async function fixture(content = "before\n"): Promise<{ root: string; file: string }> {
	const root = await mkdtemp(join(tmpdir(), "council-transaction-runtime-"))
	const file = join(root, "file.txt")
	await writeFile(file, content)
	roots.push(root)
	return { root, file }
}

async function stageCandidate(runtime: CouncilTransactionRuntime, content = "after\n") {
	await runtime.ensure().stageWrite("file.txt", content)
	return runtime.propose()
}

async function settle(runtime: CouncilTransactionRuntime, action: "finalize" | "rollback"): Promise<void> {
	const request = runtime.settlementRequest(action)
	if (!request) throw new Error("missing settlement capability")
	await runtime.settle(request)
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("CouncilTransactionRuntime telemetry", () => {
	it("reports only stable candidate metadata and revision count", async () => {
		const { root } = await fixture()
		const runtime = new CouncilTransactionRuntime(root)
		expect(runtime.snapshot()).toBeUndefined()

		await runtime.ensure().stageWrite("file.txt", "after\n")
		const candidate = runtime.propose()
		runtime.setReviewAgreement("high")
		runtime.reopenForRevision(candidate.patchSha256)

		expect(runtime.snapshot()).toMatchObject({
			transactionId: candidate.transactionId,
			state: "revision",
			outcome: "pending",
			patchSha256: candidate.patchSha256,
			stats: candidate.stats,
			baseVerification: "not_run",
			revisionCount: 1,
			postApplyChecks: [],
			rollbackState: "not_available",
			hardRecoveryRequired: false,
		})
		expect(JSON.stringify(runtime.snapshot())).not.toMatch(/token|capability/i)
		expect(runtime.reviewAgreement).toBe("high")
	})

	it("records successful base verification, post-apply checks, and rollback", async () => {
		const { root, file } = await fixture()
		const runtime = new CouncilTransactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", "after\n")
		const candidate = runtime.propose()
		await runtime.apply(runtime.accept(candidate.patchSha256))
		runtime.recordPostApplyCheck("bash", "pnpm test", false)
		const settlement = runtime.settlementRequest("rollback")
		if (!settlement) throw new Error("missing settlement capability")
		await runtime.settle(settlement)

		expect(await readFile(file, "utf8")).toBe("before\n")
		expect(runtime.snapshot()).toMatchObject({
			state: "rolled_back",
			outcome: "rolled_back",
			baseVerification: "passed",
			postApplyChecks: [{ toolName: "bash", ok: false }],
			rollbackState: "completed",
			hardRecoveryRequired: false,
		})
	})

	it("binds settlement to every exact required validation command", async () => {
		const { root } = await fixture()
		const runtime = new CouncilTransactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", "after\n")
		const candidate = runtime.propose()
		runtime.setRequiredPostApplyChecks(["pnpm test", "pnpm run typecheck"])
		await runtime.apply(runtime.accept(candidate.patchSha256))

		runtime.recordPostApplyCheck("bash", "pnpm run lint", true)
		expect(runtime.postApplyChecksComplete).toBe(false)
		expect(runtime.pendingPostApplyCheck).toBe("pnpm test")

		runtime.recordPostApplyCheck("bash", "pnpm test", true)
		expect(runtime.postApplyChecksComplete).toBe(false)
		expect(runtime.pendingPostApplyCheck).toBe("pnpm run typecheck")

		runtime.recordPostApplyCheck("bash", "pnpm run typecheck", true)
		expect(runtime.postApplyChecksComplete).toBe(true)
		expect(runtime.postApplyChecksPassed).toBe(true)
	})

	it("emits settlement capability once and keeps rollback available if execution is denied", async () => {
		const { root, file } = await fixture()
		const runtime = new CouncilTransactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", "after\n")
		const candidate = runtime.propose()
		await runtime.apply(runtime.accept(candidate.patchSha256))
		runtime.recordPostApplyCheck("bash", "pnpm test", true)

		expect(runtime.settlementRequest("finalize")).toBeDefined()
		expect(runtime.settlementRequest("finalize")).toBeUndefined()

		await runtime.abandon()
		expect(await readFile(file, "utf8")).toBe("before\n")
		expect(runtime.state).toBe("rolled_back")
		expect(runtime.reviewAgreement).toBeUndefined()
	})

	it.each([
		{
			state: "applied",
			prepare: async (runtime: CouncilTransactionRuntime) => {
				const candidate = await stageCandidate(runtime)
				runtime.setReviewAgreement("high")
				await runtime.apply(runtime.accept(candidate.patchSha256, "Reviewed response"))
				runtime.recordPostApplyCheck("bash", "pnpm test", true)
				await settle(runtime, "finalize")
			},
		},
		{
			state: "rolled_back",
			prepare: async (runtime: CouncilTransactionRuntime) => {
				const candidate = await stageCandidate(runtime)
				await runtime.apply(runtime.accept(candidate.patchSha256))
				runtime.recordPostApplyCheck("bash", "pnpm test", false)
				await settle(runtime, "rollback")
			},
		},
		{
			state: "failed",
			prepare: async (runtime: CouncilTransactionRuntime, file: string) => {
				const candidate = await stageCandidate(runtime)
				const promotion = runtime.accept(candidate.patchSha256)
				await writeFile(file, "external change\n")
				await expect(runtime.apply(promotion)).rejects.toThrow("Workspace changed after review")
			},
		},
		{
			state: "discarded",
			prepare: async (runtime: CouncilTransactionRuntime) => {
				await stageCandidate(runtime)
				await runtime.abandon()
			},
		},
	])("starts a fresh next turn after $state", async ({ state, prepare }) => {
		const { root, file } = await fixture()
		const runtime = new CouncilTransactionRuntime(root)
		await prepare(runtime, file)
		const previous = runtime.current
		expect(runtime.state).toBe(state)

		await runtime.resetForNewTurn()

		expect(runtime.current).not.toBe(previous)
		expect(runtime.state).toBe("exploring")
		expect(runtime.acceptedResponse).toBeUndefined()
		expect(runtime.reviewAgreement).toBeUndefined()
		expect(runtime.checks).toEqual([])
		await runtime.ensure().stageWrite("file.txt", "next\n")
		expect(runtime.propose().transactionId).toBe(runtime.current?.id)
	})

	it("rolls back post-apply changes before rotating to the next turn", async () => {
		const { root, file } = await fixture()
		const runtime = new CouncilTransactionRuntime(root)
		const candidate = await stageCandidate(runtime)
		await runtime.apply(runtime.accept(candidate.patchSha256))
		const previous = runtime.current
		expect(await readFile(file, "utf8")).toBe("after\n")

		await runtime.resetForNewTurn()

		expect(await readFile(file, "utf8")).toBe("before\n")
		expect(runtime.current).not.toBe(previous)
		expect(runtime.state).toBe("exploring")
	})

	it("records failed base verification without claiming rollback", async () => {
		const { root, file } = await fixture()
		const runtime = new CouncilTransactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", "after\n")
		const candidate = runtime.propose()
		const promotion = runtime.accept(candidate.patchSha256)
		await writeFile(file, "external change\n")

		await expect(runtime.apply(promotion)).rejects.toThrow("Workspace changed after review")
		expect(runtime.snapshot()).toMatchObject({
			state: "failed",
			outcome: "failed",
			baseVerification: "failed",
			rollbackState: "not_available",
			hardRecoveryRequired: false,
		})
	})

	it("surfaces failed rollback as hard recovery without exposing settlement capability", async () => {
		const { root, file } = await fixture()
		const runtime = new CouncilTransactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", "after\n")
		const candidate = runtime.propose()
		await runtime.apply(runtime.accept(candidate.patchSha256))
		await writeFile(file, "concurrent change\n")
		const settlement = runtime.settlementRequest("rollback")
		if (!settlement) throw new Error("missing settlement capability")

		await expect(runtime.settle(settlement)).rejects.toThrow("Rollback could not safely restore")
		const snapshot = runtime.snapshot()
		expect(snapshot).toMatchObject({
			state: "hard_recovery",
			outcome: "hard_recovery",
			baseVerification: "passed",
			rollbackState: "failed",
			hardRecoveryRequired: true,
		})
		expect(JSON.stringify(snapshot)).not.toContain(settlement.token)

		const failedTransaction = runtime.current
		await runtime.resetForNewTurn()
		expect(runtime.current).toBe(failedTransaction)
		expect(runtime.ensure()).toBe(failedTransaction)
		expect(runtime.snapshot()).toMatchObject({
			state: "hard_recovery",
			outcome: "hard_recovery",
			hardRecoveryRequired: true,
		})
	})
})
