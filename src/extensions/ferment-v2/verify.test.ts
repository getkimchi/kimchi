import { execFile as execFileCallback } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { evaluateFermentV2, type FermentV2EvaluationResult } from "./evaluator.js"
import { type FermentV2VerifyRequest, runFermentV2Verify } from "./verify.js"

vi.mock("./evaluator.js", () => ({ evaluateFermentV2: vi.fn() }))

const evaluateMock = vi.mocked(evaluateFermentV2)
const execFile = promisify(execFileCallback)

const DIAGNOSTICS = { durationMs: 1, timeoutMs: 0, providerRequestCount: 1, timeoutCount: 0, correctionCount: 0 }
const MET: FermentV2EvaluationResult = {
	verdict: "met",
	reason: "All requirements verified.",
	model: "judge/independent",
	usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, costUsd: 0.01 },
	diagnostics: DIAGNOSTICS,
	checks: [{ kind: "work", requirement: "ship it", status: "pass", failureMode: "fm", evidence: ["e1"] }],
	facts: { basis: "outside_git" },
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
	const { stdout } = await execFile("git", args, { cwd, encoding: "utf-8" })
	return stdout.trim()
}

/** Commit one file per message and return the HEAD sha after each commit. */
async function initRepo(dir: string, messages: readonly string[] = ["initial"]): Promise<string[]> {
	await git(dir, ["init", "-q"])
	await git(dir, ["config", "user.email", "test@example.com"])
	await git(dir, ["config", "user.name", "Test"])
	const heads: string[] = []
	for (const [index, message] of messages.entries()) {
		writeFileSync(join(dir, `file-${index}.txt`), `${message}\n`)
		await git(dir, ["add", "-A"])
		await git(dir, ["commit", "-q", "-m", message])
		heads.push(await git(dir, ["rev-parse", "HEAD"]))
	}
	return heads
}

describe("runFermentV2Verify", () => {
	let dir: string

	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-v2-verify-")))
		evaluateMock.mockReset().mockResolvedValue(MET)
	})

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	function run(request: Partial<FermentV2VerifyRequest> = {}) {
		return runFermentV2Verify(
			{ objectiveFile: "objective.md", out: "out/report.json", ...request },
			createContext({ cwd: dir }),
			createExtensionApi().api,
		)
	}

	function readReport(path = "out/report.json") {
		return JSON.parse(readFileSync(join(dir, path), "utf-8"))
	}

	it("verifies against HEAD by default, transcript-free, and writes the report", async () => {
		const [head] = await initRepo(dir)
		writeFileSync(join(dir, "objective.md"), "Ship it.\n")

		await run()

		expect(evaluateMock).toHaveBeenCalledOnce()
		const [input] = evaluateMock.mock.calls[0] ?? []
		expect(input).toMatchObject({
			objective: "Ship it.\n",
			cwd: dir,
			messages: [],
			todos: [],
			baseline: { commit: head, capturedAt: expect.any(String) },
		})
		expect(input?.previousGap).toBeUndefined()
		expect(input?.completionConfidence).toBeUndefined()
		expect(readReport()).toEqual({
			schemaVersion: 1,
			objectiveFile: join(dir, "objective.md"),
			baseline: head,
			verdict: "met",
			reason: "All requirements verified.",
			checks: MET.checks,
			model: "judge/independent",
			sameModelAsImplementer: false,
			modelFallback: null,
			usage: MET.usage,
			diagnostics: DIAGNOSTICS,
			facts: { basis: "outside_git" },
			integrity: null,
		})
	})

	it("resolves an explicit --baseline revision to its commit", async () => {
		const [first] = await initRepo(dir, ["first", "second"])
		writeFileSync(join(dir, "objective.md"), "Ship it.\n")

		await run({ baseline: "HEAD~1" })

		expect(evaluateMock.mock.calls[0]?.[0].baseline?.commit).toBe(first)
		expect(readReport().baseline).toBe(first)
	})

	it("runs without a baseline outside git", async () => {
		writeFileSync(join(dir, "objective.md"), "Research the API.\n")

		await run()

		expect(evaluateMock.mock.calls[0]?.[0]).not.toHaveProperty("baseline")
		expect(readReport()).toMatchObject({ baseline: null, verdict: "met" })
	})

	it.each([
		{ name: "an unknown baseline", baseline: "no-such-ref", error: "--baseline no-such-ref does not name a commit" },
		{ name: "an option-like baseline", baseline: "-p", error: "--baseline -p is not a revision" },
	])("writes an error report for $name without running the verifier", async ({ baseline, error }) => {
		await initRepo(dir)
		writeFileSync(join(dir, "objective.md"), "Ship it.\n")

		await run({ baseline })

		expect(evaluateMock).not.toHaveBeenCalled()
		expect(readReport()).toEqual({
			schemaVersion: 1,
			objectiveFile: join(dir, "objective.md"),
			error: expect.stringContaining(error),
		})
	})

	it("writes an error report when the objective file is missing or empty", async () => {
		await run({ out: "missing.json" })
		expect(readReport("missing.json").error).toContain("Could not read objective file")

		writeFileSync(join(dir, "objective.md"), "  \n")
		await run({ out: "empty.json" })
		expect(readReport("empty.json").error).toContain("is empty")
		expect(evaluateMock).not.toHaveBeenCalled()
	})

	it("reports unavailable verdicts with their failure type and no checks", async () => {
		writeFileSync(join(dir, "objective.md"), "Ship it.\n")
		evaluateMock.mockResolvedValue({
			verdict: "unavailable",
			reason: "No verifier model is available.",
			diagnostics: { ...DIAGNOSTICS, failureType: "no_model" },
		})

		const report = await run()

		expect(report).toMatchObject({ verdict: "unavailable", checks: [], model: null, usage: null })
		expect(readReport().diagnostics.failureType).toBe("no_model")
	})
})
