import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RunBudgetLimits, RunBudgetSnapshot } from "./run-context.js"
import {
	CouncilTransactionRuntime,
	MAX_CANDIDATE_CHECKS_PER_TURN,
	MAX_TRANSACTION_REEMISSIONS,
} from "./transaction-runtime.js"
import type { ValidationCheck } from "./validation.js"

const execFileAsync = promisify(execFile)

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
	{
		id: "package.typecheck",
		kind: "typecheck",
		cwd: ".",
		executable: "node",
		args: ["--check", "file.txt"],
		timeoutMs: 30_000,
		mutationPolicy: "read-only",
		expectedOutputs: [],
	},
]
const buildCheck: ValidationCheck = {
	id: "repo.build",
	kind: "build",
	cwd: ".",
	executable: "node",
	args: ["build.js"],
	timeoutMs: 30_000,
	mutationPolicy: "expected-output-only",
	expectedOutputs: ["build-output"],
}

function runtimeWithChecks(root: string): CouncilTransactionRuntime {
	return new CouncilTransactionRuntime(root, undefined, validationChecks)
}

function runtimeWithBuildCheck(root: string): CouncilTransactionRuntime {
	return new CouncilTransactionRuntime(root, undefined, [buildCheck])
}

async function initGitRepo(root: string): Promise<void> {
	await execFileAsync("git", ["init", "-q"], { cwd: root })
	await execFileAsync("git", ["add", "-A"], { cwd: root })
	await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: root })
}

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
	it("reports only stable candidate metadata", async () => {
		const { root } = await fixture()
		const runtime = new CouncilTransactionRuntime(root)
		expect(runtime.snapshot()).toBeUndefined()

		await runtime.ensure().stageWrite("file.txt", "after\n")
		const candidate = runtime.propose()

		expect(runtime.snapshot()).toMatchObject({
			transactionId: candidate.transactionId,
			state: "proposed",
			outcome: "pending",
			patchSha256: candidate.patchSha256,
			stats: candidate.stats,
			baseVerification: "not_run",
			postApplyChecks: [],
			rollbackState: "not_available",
			hardRecoveryRequired: false,
		})
		expect(JSON.stringify(runtime.snapshot())).not.toMatch(/token|capability/i)
	})

	it("records successful base verification, post-apply checks, and rollback", async () => {
		const { root, file } = await fixture()
		const runtime = runtimeWithChecks(root)
		await runtime.ensure().stageWrite("file.txt", "after\n")
		const candidate = runtime.propose()
		runtime.setRequiredPostApplyChecks(["package.test"])
		await runtime.apply(runtime.accept(candidate.patchSha256))
		const check = await runtime.preparePostApplyCheck()
		if (!check) throw new Error("missing validation check")
		await runtime.recordPostApplyCheck("bash", check.id, false)
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
		const runtime = runtimeWithChecks(root)
		await runtime.ensure().stageWrite("file.txt", "after\n")
		const candidate = runtime.propose()
		runtime.setRequiredPostApplyChecks(["package.test", "package.typecheck"])
		await runtime.apply(runtime.accept(candidate.patchSha256))

		await runtime.recordPostApplyCheck("bash", "unrelated.check", true)
		expect(runtime.postApplyChecksComplete).toBe(false)
		expect(runtime.pendingPostApplyCheck?.id).toBe("package.test")

		const test = await runtime.preparePostApplyCheck()
		if (!test) throw new Error("missing test check")
		await runtime.recordPostApplyCheck("bash", test.id, true)
		expect(runtime.postApplyChecksComplete).toBe(false)
		expect(runtime.pendingPostApplyCheck?.id).toBe("package.typecheck")

		const typecheck = await runtime.preparePostApplyCheck()
		if (!typecheck) throw new Error("missing typecheck")
		await runtime.recordPostApplyCheck("bash", typecheck.id, true)
		expect(runtime.postApplyChecksComplete).toBe(true)
		expect(runtime.postApplyChecksPassed).toBe(true)
	})

	it("finalizes without post-apply checks only when the catalog is empty", async () => {
		const { root, file } = await fixture()
		const runtime = new CouncilTransactionRuntime(root)
		const candidate = await stageCandidate(runtime)

		await runtime.apply(runtime.accept(candidate.patchSha256, "Applied.", "no_validation_checks"))

		expect(runtime.postApplyChecksComplete).toBe(true)
		expect(runtime.postApplyChecksPassed).toBe(true)
		await settle(runtime, "finalize")
		expect(runtime.state).toBe("applied")
		expect(await readFile(file, "utf8")).toBe("after\n")
		expect(runtime.acceptedDegradedReason).toBe("no_validation_checks")
	})

	it("keeps a non-empty catalog blocked until a check is selected and passes", async () => {
		const { root } = await fixture()
		const runtime = runtimeWithChecks(root)
		const candidate = await stageCandidate(runtime)

		await runtime.apply(runtime.accept(candidate.patchSha256, "Applied."))

		expect(runtime.postApplyChecksComplete).toBe(false)
		expect(runtime.postApplyChecksPassed).toBe(false)
		expect(runtime.settlementRequest("finalize")).toBeUndefined()
	})

	it("re-emits the identical settlement request when the host never executes it, then rolls back once the bound is exhausted", async () => {
		const { root, file } = await fixture()
		const runtime = runtimeWithChecks(root)
		await runtime.ensure().stageWrite("file.txt", "after\n")
		const candidate = runtime.propose()
		runtime.setRequiredPostApplyChecks(["package.test"])
		await runtime.apply(runtime.accept(candidate.patchSha256))
		const check = await runtime.preparePostApplyCheck()
		if (!check) throw new Error("missing validation check")
		await runtime.recordPostApplyCheck("bash", check.id, true)

		const first = runtime.settlementRequest("finalize")
		expect(first).toBeDefined()
		expect(runtime.settlementDeliveryExhausted).toBe(false)

		// The host never executed the settle tool call; re-entry re-emits the same request.
		for (let attempt = 0; attempt < MAX_TRANSACTION_REEMISSIONS; attempt++) {
			const reemitted = runtime.settlementRequest("finalize")
			expect(reemitted).toEqual(first)
		}

		// The re-emission bound is now exhausted: no further settlement request is issued.
		expect(runtime.settlementDeliveryExhausted).toBe(true)
		expect(runtime.settlementRequest("finalize")).toBeUndefined()

		await runtime.abandon()
		expect(await readFile(file, "utf8")).toBe("before\n")
		expect(runtime.state).toBe("rolled_back")
	})

	it("keeps re-emitting a rollback settlement request past what would exhaust a finalize request, and still delivers", async () => {
		const { root, file } = await fixture()
		const runtime = runtimeWithChecks(root)
		await runtime.ensure().stageWrite("file.txt", "after\n")
		const candidate = runtime.propose()
		runtime.setRequiredPostApplyChecks(["package.test"])
		await runtime.apply(runtime.accept(candidate.patchSha256))
		const check = await runtime.preparePostApplyCheck()
		if (!check) throw new Error("missing validation check")
		await runtime.recordPostApplyCheck("bash", check.id, false)

		const first = runtime.settlementRequest("rollback")
		expect(first).toBeDefined()
		expect(runtime.settlementDeliveryExhausted).toBe(false)

		// The host never executes the settle tool call. Rollback re-emission has no bound to exhaust:
		// it keeps returning the identical request well past MAX_TRANSACTION_REEMISSIONS attempts.
		let last = first
		for (let attempt = 0; attempt < MAX_TRANSACTION_REEMISSIONS * 3; attempt++) {
			last = runtime.settlementRequest("rollback")
			expect(last).toEqual(first)
			expect(runtime.settlementDeliveryExhausted).toBe(false)
		}

		// The host finally executes the re-emitted request: the workspace ends up rolled back.
		if (!last) throw new Error("missing rollback settlement")
		await runtime.settle(last)
		expect(await readFile(file, "utf8")).toBe("before\n")
		expect(runtime.state).toBe("rolled_back")
	})

	it("never finalizes a patch whose post-apply checks failed, even across settlement re-emission", async () => {
		const { root, file } = await fixture()
		const runtime = runtimeWithChecks(root)
		await runtime.ensure().stageWrite("file.txt", "after\n")
		const candidate = runtime.propose()
		runtime.setRequiredPostApplyChecks(["package.test"])
		await runtime.apply(runtime.accept(candidate.patchSha256))
		const check = await runtime.preparePostApplyCheck()
		if (!check) throw new Error("missing validation check")
		await runtime.recordPostApplyCheck("bash", check.id, false)

		expect(runtime.postApplyChecksPassed).toBe(false)
		expect(runtime.settlementRequest("finalize")).toBeUndefined()

		const rollback = runtime.settlementRequest("rollback")
		if (!rollback) throw new Error("missing rollback settlement")
		const reemitted = runtime.settlementRequest("rollback")
		expect(reemitted).toEqual(rollback)

		await runtime.settle(rollback)
		expect(await readFile(file, "utf8")).toBe("before\n")
		expect(runtime.state).toBe("rolled_back")
		expect(runtime.settlementRequest("finalize")).toBeUndefined()
	})

	it("re-emits the identical apply request when the host never executes it, then denies delivery once the bound is exhausted", async () => {
		const { root, file } = await fixture()
		const runtime = runtimeWithChecks(root)
		await runtime.ensure().stageWrite("file.txt", "after\n")
		const candidate = runtime.propose()
		const first = runtime.accept(candidate.patchSha256)
		expect(runtime.state).toBe("accepted")
		expect(runtime.applyDeliveryExhausted).toBe(false)

		// The host never executed the apply tool call; re-entry re-emits the same request.
		for (let attempt = 0; attempt < MAX_TRANSACTION_REEMISSIONS; attempt++) {
			const reemitted = runtime.applyRequest()
			expect(reemitted).toEqual(first)
		}

		// The re-emission bound is now exhausted: no further apply request is issued.
		expect(runtime.applyDeliveryExhausted).toBe(true)
		expect(runtime.applyRequest()).toBeUndefined()
		expect(runtime.state).toBe("accepted")
		expect(await readFile(file, "utf8")).toBe("before\n")
	})

	it("fails closed on base drift even when the apply request was re-emitted, and cannot double-apply", async () => {
		const { root, file } = await fixture()
		const runtime = runtimeWithChecks(root)
		await runtime.ensure().stageWrite("file.txt", "after\n")
		const candidate = runtime.propose()
		const first = runtime.accept(candidate.patchSha256)

		const reemitted = runtime.applyRequest()
		expect(reemitted).toEqual(first)

		await writeFile(file, "drifted\n")
		if (!reemitted) throw new Error("missing re-emitted apply request")
		await expect(runtime.apply(reemitted)).rejects.toThrow(/changed after review/)
		expect(await readFile(file, "utf8")).toBe("drifted\n")
		expect(runtime.state).toBe("failed")

		// The transaction is terminal after the failed apply; it cannot be applied again.
		expect(runtime.applyRequest()).toBeUndefined()
		await expect(runtime.apply(reemitted)).rejects.toThrow()
	})

	it("cannot double-apply once a re-emitted apply request has already succeeded", async () => {
		const { root, file } = await fixture()
		const runtime = runtimeWithChecks(root)
		await runtime.ensure().stageWrite("file.txt", "after\n")
		const candidate = runtime.propose()
		runtime.accept(candidate.patchSha256)

		const reemitted = runtime.applyRequest()
		if (!reemitted) throw new Error("missing re-emitted apply request")
		await runtime.apply(reemitted)
		expect(await readFile(file, "utf8")).toBe("after\n")
		expect(runtime.state).toBe("post_apply_checks")

		// A second, late-arriving copy of the same apply request cannot re-apply the transaction.
		await expect(runtime.apply(reemitted)).rejects.toThrow()
		expect(await readFile(file, "utf8")).toBe("after\n")
	})

	it("restores an unexpectedly mutated touched file and blocks finalization", async () => {
		const { root, file } = await fixture()
		const runtime = runtimeWithChecks(root)
		await runtime.ensure().stageWrite("file.txt", "after\n")
		const candidate = runtime.propose()
		runtime.setRequiredPostApplyChecks(["package.test"])
		await runtime.apply(runtime.accept(candidate.patchSha256))
		const check = await runtime.preparePostApplyCheck()
		if (!check) throw new Error("missing validation check")
		await writeFile(file, "unexpected\n")

		await runtime.recordPostApplyCheck("bash", check.id, true)

		expect(await readFile(file, "utf8")).toBe("after\n")
		expect(runtime.postApplyChecksPassed).toBe(false)
		expect(runtime.settlementRequest("finalize")).toBeUndefined()
		expect(runtime.checks[0]).toMatchObject({
			id: "package.test",
			ok: false,
			mutation: "unexpected_restored",
		})
		await settle(runtime, "rollback")
		expect(await readFile(file, "utf8")).toBe("before\n")
	})

	it("fails a check on git-status drift outside the patch's touched files (git workspace only)", async () => {
		const { root, file } = await fixture()
		await initGitRepo(root)
		const runtime = runtimeWithChecks(root)
		await runtime.ensure().stageWrite("file.txt", "after\n")
		const candidate = runtime.propose()
		runtime.setRequiredPostApplyChecks(["package.test"])
		await runtime.apply(runtime.accept(candidate.patchSha256))
		const check = await runtime.preparePostApplyCheck()
		if (!check) throw new Error("missing validation check")
		await writeFile(join(root, "leaked.txt"), "unexpected\n")

		await runtime.recordPostApplyCheck("bash", check.id, true)

		expect(await readFile(file, "utf8")).toBe("after\n")
		expect(runtime.postApplyChecksPassed).toBe(false)
		expect(runtime.checks[0]).toMatchObject({ id: "package.test", ok: false })
		await rm(join(root, "leaked.txt"), { force: true })
	})

	it("does not fail the git-status canary when a check creates its own typed expected output", async () => {
		const { root, file } = await fixture()
		await initGitRepo(root)
		const runtime = runtimeWithBuildCheck(root)
		await runtime.ensure().stageWrite("file.txt", "after\n")
		const candidate = runtime.propose()
		runtime.setRequiredPostApplyChecks(["repo.build"])
		await runtime.apply(runtime.accept(candidate.patchSha256))
		const check = await runtime.preparePostApplyCheck()
		if (!check) throw new Error("missing validation check")

		await mkdir(join(root, "build-output"), { recursive: true })
		await writeFile(join(root, "build-output", "bundle.js"), "compiled\n")

		await runtime.recordPostApplyCheck("bash", check.id, true)

		expect(await readFile(file, "utf8")).toBe("after\n")
		expect(runtime.checks[0]).toMatchObject({ id: "repo.build", ok: true, mutation: "expected_only" })
		expect(runtime.postApplyChecksPassed).toBe(true)
	})

	it("still fails the git-status canary when a check mutates a file outside its expected outputs", async () => {
		const { root, file } = await fixture()
		await initGitRepo(root)
		const runtime = runtimeWithBuildCheck(root)
		await runtime.ensure().stageWrite("file.txt", "after\n")
		const candidate = runtime.propose()
		runtime.setRequiredPostApplyChecks(["repo.build"])
		await runtime.apply(runtime.accept(candidate.patchSha256))
		const check = await runtime.preparePostApplyCheck()
		if (!check) throw new Error("missing validation check")
		await writeFile(join(root, "unrelated.txt"), "leak\n")

		await runtime.recordPostApplyCheck("bash", check.id, true)

		expect(await readFile(file, "utf8")).toBe("after\n")
		expect(runtime.checks[0]).toMatchObject({ id: "repo.build", ok: false })
		expect(runtime.postApplyChecksPassed).toBe(false)
		await rm(join(root, "unrelated.txt"), { force: true })
	})

	it("debug-logs restore failures without changing the hard-recovery outcome", async () => {
		const { root, file } = await fixture()
		const runtime = runtimeWithChecks(root)
		const candidate = await stageCandidate(runtime)
		runtime.setRequiredPostApplyChecks(["package.test"])
		await runtime.apply(runtime.accept(candidate.patchSha256))
		const check = await runtime.preparePostApplyCheck()
		if (!check) throw new Error("missing validation check")
		const previousDebug = process.env.KIMCHI_COUNCIL_DEBUG
		process.env.KIMCHI_COUNCIL_DEBUG = "1"
		const debug = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			await rm(file, { force: true })
			await mkdir(file)
			await runtime.recordPostApplyCheck("bash", check.id, true)
			expect(debug).toHaveBeenCalledWith(
				expect.stringContaining("restorePatchFiles failed after post-apply mutation"),
				expect.anything(),
			)
		} finally {
			if (previousDebug === undefined) delete process.env.KIMCHI_COUNCIL_DEBUG
			else process.env.KIMCHI_COUNCIL_DEBUG = previousDebug
			debug.mockRestore()
		}

		expect(runtime.checks[0]).toMatchObject({ ok: false, mutation: "unexpected_restore_failed" })
	})

	it("rejects unknown validation IDs before apply", async () => {
		const { root } = await fixture()
		const runtime = runtimeWithChecks(root)
		await runtime.ensure().stageWrite("file.txt", "after\n")
		runtime.propose()

		expect(() => runtime.setRequiredPostApplyChecks(["unknown.check"])).toThrow(
			"Council selected unknown validation check",
		)
	})

	it("stores the public response byte-for-byte", async () => {
		const { root } = await fixture()
		const runtime = runtimeWithChecks(root)
		const candidate = await stageCandidate(runtime)
		const publicResponse = "\nPublic response with intentional whitespace.\n"

		runtime.accept(candidate.patchSha256, publicResponse)

		expect(runtime.acceptedResponse).toBe(publicResponse)
	})

	it.each([
		{
			state: "applied",
			prepare: async (runtime: CouncilTransactionRuntime) => {
				const candidate = await stageCandidate(runtime)
				runtime.setRequiredPostApplyChecks(["package.test"])
				await runtime.apply(runtime.accept(candidate.patchSha256, "Public response"))
				const check = await runtime.preparePostApplyCheck()
				if (!check) throw new Error("missing validation check")
				await runtime.recordPostApplyCheck("bash", check.id, true)
				await settle(runtime, "finalize")
			},
		},
		{
			state: "rolled_back",
			prepare: async (runtime: CouncilTransactionRuntime) => {
				const candidate = await stageCandidate(runtime)
				runtime.setRequiredPostApplyChecks(["package.test"])
				await runtime.apply(runtime.accept(candidate.patchSha256))
				const check = await runtime.preparePostApplyCheck()
				if (!check) throw new Error("missing validation check")
				await runtime.recordPostApplyCheck("bash", check.id, false)
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
		const runtime = runtimeWithChecks(root)
		await prepare(runtime, file)
		const previous = runtime.current
		expect(runtime.state).toBe(state)

		await runtime.resetForNewTurn()

		expect(runtime.current).not.toBe(previous)
		expect(runtime.state).toBe("exploring")
		expect(runtime.acceptedResponse).toBeUndefined()
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

	it("surfaces failed rollback as hard recovery", async () => {
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

const readCandidateCheck: ValidationCheck = {
	id: "candidate.read",
	kind: "test",
	cwd: ".",
	executable: "node",
	args: ["-e", "process.stdout.write(require('fs').readFileSync('file.txt','utf8'))"],
	timeoutMs: 5_000,
	mutationPolicy: "read-only",
	expectedOutputs: [],
}

function runtimeWithReadCheck(root: string): CouncilTransactionRuntime {
	return new CouncilTransactionRuntime(root, undefined, [readCandidateCheck])
}

function zeroRunBudget(deadlineAt: number) {
	const limits: RunBudgetLimits = {
		overallTimeoutMs: 60_000,
		maxLogicalCalls: 40,
		maxPhysicalAttempts: 48,
		maxConcurrentCalls: 3,
		maxAggregateInputTokens: 1,
		maxAggregateOutputTokens: 1,
		maxEvidenceBytes: 1,
		maxStructuredBytes: 1,
	}
	const snapshot: RunBudgetSnapshot = {
		logicalCalls: 0,
		physicalAttempts: 0,
		activeCalls: 0,
		peakConcurrentCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		evidenceBytes: 0,
		structuredBytes: 0,
	}
	return { limits, startedAt: Date.now(), deadlineAt, snapshot, repairsUsed: 0, repairedStages: [] }
}

describe("CouncilTransactionRuntime.checkCandidate", () => {
	it("runs a catalog check against the staged candidate without touching the on-disk original", async () => {
		const { root, file } = await fixture("original\n")
		const runtime = runtimeWithReadCheck(root)
		await runtime.ensure().stageWrite("file.txt", "candidate\n")

		const outcome = await runtime.checkCandidate("candidate.read")

		expect(outcome).toMatchObject({ id: "candidate.read", kind: "test", ok: true, exitCode: 0 })
		expect(outcome.output).toContain("candidate")
		expect(outcome.output).not.toContain("original")
		expect(await readFile(file, "utf8")).toBe("original\n")
	})

	it("rejects a check id outside the validation catalog", async () => {
		const { root } = await fixture()
		const runtime = runtimeWithReadCheck(root)
		await runtime.ensure().stageWrite("file.txt", "candidate\n")

		await expect(runtime.checkCandidate("not.a.catalog.check")).rejects.toThrow("Unknown Council validation check")
	})

	it("refuses to verify before anything is staged", async () => {
		const { root } = await fixture()
		const runtime = runtimeWithReadCheck(root)
		runtime.ensure()

		await expect(runtime.checkCandidate("candidate.read")).rejects.toThrow("requires staged changes")
	})

	it("enforces the per-turn invocation bound, then allows fresh checks after the next turn", async () => {
		const { root } = await fixture()
		const runtime = runtimeWithReadCheck(root)
		await runtime.ensure().stageWrite("file.txt", "candidate\n")

		for (let attempt = 0; attempt < MAX_CANDIDATE_CHECKS_PER_TURN; attempt++) {
			await expect(runtime.checkCandidate("candidate.read")).resolves.toMatchObject({ ok: true })
		}
		expect(runtime.candidateChecksUsed).toBe(MAX_CANDIDATE_CHECKS_PER_TURN)
		await expect(runtime.checkCandidate("candidate.read")).rejects.toThrow("verification limit reached")

		await runtime.resetForNewTurn()
		expect(runtime.candidateChecksUsed).toBe(0)
		await runtime.ensure().stageWrite("file.txt", "candidate again\n")
		await expect(runtime.checkCandidate("candidate.read")).resolves.toMatchObject({ ok: true })
	})

	it("refuses to run once the saved whole-run deadline has already passed", async () => {
		const { root } = await fixture()
		const runtime = runtimeWithReadCheck(root)
		await runtime.ensure().stageWrite("file.txt", "candidate\n")
		runtime.saveRunBudget(zeroRunBudget(Date.now() - 1))

		await expect(runtime.checkCandidate("candidate.read")).rejects.toThrow("deadline exceeded")
	})

	it("propagates an aborted check and still allows a fresh one afterward", async () => {
		const { root } = await fixture()
		const runtime = runtimeWithReadCheck(root)
		await runtime.ensure().stageWrite("file.txt", "candidate\n")
		const controller = new AbortController()
		controller.abort()

		await expect(runtime.checkCandidate("candidate.read", controller.signal)).rejects.toThrow()
		await expect(runtime.checkCandidate("candidate.read")).resolves.toMatchObject({ ok: true })
	})
})
