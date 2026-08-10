import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { Api, Model } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RunBudgetLimits, RunBudgetSnapshot } from "./run-context.js"
import {
	COUNCIL_APPLY_TOOL,
	COUNCIL_CHECK_TOOL,
	COUNCIL_DELETE_TOOL,
	COUNCIL_RENAME_TOOL,
	COUNCIL_SETTLE_TOOL,
	CouncilTransactionRuntime,
	installCouncilMutationGuard,
	MAX_CANDIDATE_CHECKS_PER_TURN,
	MAX_TRANSACTION_REEMISSIONS,
	registerCouncilTransactionTools,
	syncCouncilTransactionToolVisibility,
	withoutInternalCouncilTools,
} from "./transaction.js"
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

interface ExecutableTool {
	name: string
	description?: string
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: (update: unknown) => void,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>
}

type ToolCallHandler = (
	event: { toolName: string; input?: unknown },
	ctx: ExtensionContext,
) => { block: true; reason: string } | undefined

const councilModel = {
	id: "council",
	name: "Kimchi Council",
	api: "kimchi-council",
	provider: "kimchi",
	baseUrl: "http://kimchi-council.invalid",
	reasoning: false,
	input: ["text"] as const,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 262_144,
	maxTokens: 16_384,
} satisfies Model<Api>

const physicalModel = {
	...councilModel,
	id: "physical",
	name: "Physical",
	api: "openai-completions",
	provider: "openai",
} satisfies Model<Api>

function harness(initialActive = ["read", "edit", "write", "bash"]) {
	const tools = new Map<string, ExecutableTool>()
	const activeTools = new Set(initialActive)
	const on = vi.fn()
	const pi = {
		getActiveTools: vi.fn(() => [...activeTools]),
		on,
		registerTool: vi.fn((tool: ExecutableTool) => {
			tools.set(tool.name, tool)
			activeTools.add(tool.name)
		}),
		setActiveTools: vi.fn((names: string[]) => {
			activeTools.clear()
			for (const name of names) activeTools.add(name)
		}),
	} as unknown as ExtensionAPI

	return {
		activeTools,
		on,
		pi,
		tool(name: string): ExecutableTool {
			const tool = tools.get(name)
			if (!tool) throw new Error(`Missing registered tool: ${name}`)
			return tool
		},
	}
}

function context(cwd: string, model: Model<Api> = councilModel): ExtensionContext {
	return { cwd, model } as ExtensionContext
}

function execute(tool: ExecutableTool, params: Record<string, unknown>, ctx: ExtensionContext) {
	return tool.execute("call-1", params, new AbortController().signal, () => undefined, ctx)
}

describe("Council transaction tools", () => {
	let workspace: string

	beforeEach(async () => {
		workspace = await realpath(await mkdtemp(join(tmpdir(), "kimchi-council-tools-")))
	})

	afterEach(async () => {
		await rm(workspace, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	it("passes non-Council tools through without consulting the transaction route", async () => {
		const runtimeLookup = vi.fn(() => {
			throw new Error("transaction lookup must not run")
		})
		const registered = harness()
		registerCouncilTransactionTools(registered.pi, workspace, runtimeLookup)

		const result = await execute(
			registered.tool("write"),
			{ path: "physical.txt", content: "physical" },
			context(workspace, physicalModel),
		)

		expect(runtimeLookup).not.toHaveBeenCalled()
		expect(await readFile(join(workspace, "physical.txt"), "utf8")).toBe("physical")
		expect(result).toEqual({
			content: [{ type: "text", text: "Successfully wrote 8 bytes to physical.txt" }],
			details: undefined,
		})
	})

	it("writes and reads the Council overlay while leaving the workspace unchanged", async () => {
		await writeFile(join(workspace, "note.txt"), "original\n")
		const runtime = new CouncilTransactionRuntime(workspace)
		const registered = harness()
		registerCouncilTransactionTools(registered.pi, workspace, () => runtime)

		await execute(registered.tool("write"), { path: "note.txt", content: "candidate\n" }, context(workspace))
		const result = await execute(registered.tool("read"), { path: "note.txt" }, context(workspace))

		expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe("original\n")
		expect(await runtime.current?.readBuffer("note.txt")).toEqual(Buffer.from("candidate\n"))
		expect(result.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("candidate") }),
		])
	})

	it("stages deletes and renames without touching their source files", async () => {
		await writeFile(join(workspace, "delete.txt"), "keep until promotion\n")
		await writeFile(join(workspace, "source.txt"), "rename candidate\n")
		const runtime = new CouncilTransactionRuntime(workspace)
		const registered = harness()
		registerCouncilTransactionTools(registered.pi, workspace, () => runtime)

		await execute(registered.tool(COUNCIL_DELETE_TOOL), { path: "delete.txt" }, context(workspace))
		await execute(
			registered.tool(COUNCIL_RENAME_TOOL),
			{ from_path: "source.txt", to_path: "renamed.txt" },
			context(workspace),
		)

		expect(runtime.current?.changeSet().operations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "delete", path: "delete.txt" }),
				expect.objectContaining({ kind: "rename", fromPath: "source.txt", path: "renamed.txt" }),
			]),
		)
		expect(await readFile(join(workspace, "delete.txt"), "utf8")).toBe("keep until promotion\n")
		expect(await readFile(join(workspace, "source.txt"), "utf8")).toBe("rename candidate\n")
		await expect(readFile(join(workspace, "renamed.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
		await expect(runtime.current?.readBuffer("source.txt")).rejects.toMatchObject({ code: "ENOENT" })
		expect(await runtime.current?.readBuffer("renamed.txt")).toEqual(Buffer.from("rename candidate\n"))
	})

	it("fails closed for unknown and mutating tools but permits reads and post-apply checks", () => {
		const registered = harness()
		const staging = { state: "staging" } as CouncilTransactionRuntime
		const postApply = {
			state: "post_apply_checks",
			isExpectedPostApplyCheck: (checkId: string) => checkId === "package.test",
		} as unknown as CouncilTransactionRuntime
		let current = staging
		installCouncilMutationGuard(registered.pi, () => current)
		const handler = registered.on.mock.calls.find(([event]) => event === "tool_call")?.[1] as ToolCallHandler
		const ctx = context(workspace)

		expect(handler({ toolName: "mystery_mutator", input: {} }, ctx)).toMatchObject({ block: true })
		expect(handler({ toolName: "bash", input: { command: "echo changed > file.txt" } }, ctx)).toMatchObject({
			block: true,
		})
		expect(handler({ toolName: "read", input: { path: "file.txt" } }, ctx)).toBeUndefined()
		expect(handler({ toolName: "ask_user", input: { questions: [] } }, ctx)).toBeUndefined()
		expect(handler({ toolName: "bash", input: { command: "git status --short" } }, ctx)).toBeUndefined()

		current = postApply
		expect(
			handler({ toolName: "bash", input: { command: "pnpm test", council_check_id: "package.test" } }, ctx),
		).toBeUndefined()
		expect(
			handler({ toolName: "bash", input: { command: "pnpm test", council_check_id: "package.typecheck" } }, ctx),
		).toMatchObject({ block: true })
		expect(handler({ toolName: "bash", input: { command: "pnpm test" } }, ctx)).toMatchObject({
			block: true,
		})
		expect(handler({ toolName: "bash", input: { command: "echo bad > file.txt" } }, ctx)).toMatchObject({
			block: true,
		})
		expect(handler({ toolName: "bash", input: { command: "rm file.txt" } }, ctx)).toMatchObject({ block: true })
		expect(handler({ toolName: "mystery_mutator", input: {} }, ctx)).toMatchObject({ block: true })
	})

	it("rejects an apply request with a forged transaction ID or patch hash, and a reused one", async () => {
		await writeFile(join(workspace, "reviewed.txt"), "before\n")
		const runtime = new CouncilTransactionRuntime(workspace)
		const registered = harness()
		registerCouncilTransactionTools(registered.pi, workspace, () => runtime)
		await runtime.ensure().stageWrite("reviewed.txt", "after\n")
		const candidate = runtime.propose()
		const request = runtime.accept(candidate.patchSha256)
		const apply = registered.tool(COUNCIL_APPLY_TOOL)
		const ctx = context(workspace)
		const params = {
			transaction_id: request.transactionId,
			patch_sha256: request.patchSha256,
		}

		await expect(execute(apply, { ...params, transaction_id: "forged" }, ctx)).rejects.toThrow(
			"Council apply request does not match the active transaction",
		)
		await expect(execute(apply, { ...params, patch_sha256: "forged" }, ctx)).rejects.toThrow(
			"Patch changed after acceptance",
		)
		await expect(execute(apply, params, ctx)).resolves.toMatchObject({
			content: [expect.objectContaining({ text: expect.stringContaining(candidate.patchSha256) })],
		})
		expect(await readFile(join(workspace, "reviewed.txt"), "utf8")).toBe("after\n")
		await expect(execute(apply, params, ctx)).rejects.toThrow("Cannot apply transaction while post_apply_checks")

		await runtime.abandon()
		expect(await readFile(join(workspace, "reviewed.txt"), "utf8")).toBe("before\n")
	})

	it("shows candidate tools only for Council and hides internal tools from physical calls", () => {
		const registered = harness()
		registerCouncilTransactionTools(registered.pi, workspace, () => undefined)

		syncCouncilTransactionToolVisibility(registered.pi, physicalModel)
		expect([...registered.activeTools]).toEqual(["read", "edit", "write", "bash"])

		syncCouncilTransactionToolVisibility(registered.pi, councilModel)
		expect([...registered.activeTools]).toEqual([
			"read",
			"edit",
			"write",
			"bash",
			COUNCIL_DELETE_TOOL,
			COUNCIL_RENAME_TOOL,
			COUNCIL_CHECK_TOOL,
			COUNCIL_APPLY_TOOL,
			COUNCIL_SETTLE_TOOL,
		])
		expect(
			withoutInternalCouncilTools(
				[...registered.activeTools].map((name) => ({
					name,
				})),
			).map(({ name }) => name),
		).toEqual(["read", "edit", "write", "bash", COUNCIL_DELETE_TOOL, COUNCIL_RENAME_TOOL, COUNCIL_CHECK_TOOL])
	})

	it("verifies the staged candidate in isolation, leaving the real file untouched", async () => {
		await writeFile(join(workspace, "greeting.txt"), "original\n")
		const catalog = [
			{
				id: "candidate.read",
				kind: "test" as const,
				cwd: ".",
				executable: "node",
				args: ["-e", "process.stdout.write(require('fs').readFileSync('greeting.txt','utf8'))"],
				timeoutMs: 5_000,
				mutationPolicy: "read-only" as const,
				expectedOutputs: [],
			},
		]
		const runtime = new CouncilTransactionRuntime(workspace, undefined, catalog)
		const registered = harness()
		registerCouncilTransactionTools(registered.pi, workspace, () => runtime, catalog)
		await runtime.ensure().stageWrite("greeting.txt", "candidate\n")

		const result = await execute(
			registered.tool(COUNCIL_CHECK_TOOL),
			{ check_id: "candidate.read" },
			context(workspace),
		)

		expect(result.content).toEqual([
			expect.objectContaining({
				type: "text",
				text: expect.stringMatching(/^Check "candidate\.read".*passed.*\n\ncandidate\n$/s),
			}),
		])
		expect(await readFile(join(workspace, "greeting.txt"), "utf8")).toBe("original\n")
	})

	it("rejects an unknown candidate-check id and never falls through to a shell command", async () => {
		const catalog = [
			{
				id: "package.test",
				kind: "test" as const,
				cwd: ".",
				executable: "node",
				args: ["--test"],
				timeoutMs: 5_000,
				mutationPolicy: "read-only" as const,
				expectedOutputs: [],
			},
		]
		const runtime = new CouncilTransactionRuntime(workspace, undefined, catalog)
		const registered = harness()
		registerCouncilTransactionTools(registered.pi, workspace, () => runtime, catalog)
		await runtime.ensure().stageWrite("greeting.txt", "candidate\n")

		await expect(
			execute(registered.tool(COUNCIL_CHECK_TOOL), { check_id: "not.a.catalog.check" }, context(workspace)),
		).rejects.toThrow("Unknown Council validation check")
	})

	it("lists the catalog's check ids in the tool description", () => {
		const catalog = [
			{
				id: "package.test",
				kind: "test" as const,
				cwd: ".",
				executable: "node",
				args: ["--test"],
				timeoutMs: 5_000,
				mutationPolicy: "read-only" as const,
				expectedOutputs: [],
			},
			{
				id: "package.typecheck",
				kind: "typecheck" as const,
				cwd: ".",
				executable: "tsc",
				args: ["--noEmit"],
				timeoutMs: 5_000,
				mutationPolicy: "read-only" as const,
				expectedOutputs: [],
			},
		]
		const registered = harness()
		registerCouncilTransactionTools(registered.pi, workspace, () => undefined, catalog)

		expect(registered.tool(COUNCIL_CHECK_TOOL)).toMatchObject({
			description: expect.stringContaining("package.test"),
		})
		expect(registered.tool(COUNCIL_CHECK_TOOL)).toMatchObject({
			description: expect.stringContaining("package.typecheck"),
		})
	})

	it("does not register council_check_candidate when the validation catalog is empty", () => {
		const registered = harness()
		registerCouncilTransactionTools(registered.pi, workspace, () => undefined, [])

		expect(() => registered.tool(COUNCIL_CHECK_TOOL)).toThrow("Missing registered tool")
	})

	it("permits council_check_candidate through the mutation guard without treating it as a transaction mutation", () => {
		const registered = harness()
		const staging = { state: "staging" } as CouncilTransactionRuntime
		installCouncilMutationGuard(registered.pi, () => staging)
		const handler = registered.on.mock.calls.find(([event]) => event === "tool_call")?.[1] as ToolCallHandler

		expect(
			handler({ toolName: COUNCIL_CHECK_TOOL, input: { check_id: "package.test" } }, context(workspace)),
		).toBeUndefined()
	})
})
