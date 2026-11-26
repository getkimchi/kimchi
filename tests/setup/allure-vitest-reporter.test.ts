import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TestCase, TestError } from "vitest/node"
import AllureVitestReporter from "./allure-vitest-reporter.js"

interface FakeTestCase {
	state: "passed" | "failed" | "skipped"
	retryCount?: number
	error?: TestError
}

function fakeTestCase({ state, retryCount = 0, error }: FakeTestCase): TestCase {
	return {
		name: "retries a request",
		fullName: "billing > retries a request",
		module: { relativeModuleId: "src/billing.test.ts" },
		parent: { type: "suite", fullName: "billing" },
		result: () => ({ state, errors: error ? [error] : undefined }),
		diagnostic: () => ({ startTime: 1_000, duration: 25, retryCount }),
	} as unknown as TestCase
}

function readResults(resultsDir: string) {
	return readdirSync(resultsDir)
		.filter((file) => file.endsWith("-result.json"))
		.map((file) => JSON.parse(readFileSync(join(resultsDir, file), "utf8")))
}

describe("successful Allure Vitest results", () => {
	let resultsDir: string

	beforeEach(() => {
		resultsDir = mkdtempSync(join(tmpdir(), "kimchi-vitest-allure-"))
		vi.stubEnv("GITHUB_SERVER_URL", "https://github.example")
		vi.stubEnv("GITHUB_REPOSITORY", "getkimchi/kimchi")
		vi.stubEnv("GITHUB_RUN_ID", "12345")
		vi.stubEnv("GITHUB_RUN_ATTEMPT", "2")
	})

	afterEach(() => {
		rmSync(resultsDir, { recursive: true, force: true })
		vi.unstubAllEnvs()
	})

	it.each([
		{ name: "plain pass", testCase: { state: "passed" }, status: "passed", statusDetails: undefined },
		{
			name: "retry-recovered pass",
			testCase: {
				state: "passed",
				retryCount: 2,
				error: Object.assign(new Error("first attempt failed"), { stack: "Error: first attempt failed\nstack" }),
			},
			status: "passed",
			statusDetails: {
				flaky: true,
				message: "passed after 2 failed attempts",
				trace: "Error: first attempt failed\nstack",
			},
		},
		{ name: "skip", testCase: { state: "skipped" }, status: "skipped", statusDetails: undefined },
	] as const)("writes a $name result", ({ testCase, status, statusDetails }) => {
		const reporter = new AllureVitestReporter({ resultsDir })
		reporter.onTestCaseResult(fakeTestCase(testCase))

		const results = readResults(resultsDir)
		expect(results).toHaveLength(1)
		const fullName = "src/billing.test.ts > billing > retries a request"
		const identity = createHash("sha256").update(fullName).digest("hex")
		expect(results[0]).toMatchObject({
			historyId: identity,
			testCaseId: identity,
			fullName,
			name: "retries a request",
			status,
			stage: "finished",
			start: 1_000,
			stop: 1_025,
			labels: [
				{ name: "suite", value: "billing" },
				{ name: "parentSuite", value: "src/billing.test.ts" },
				{ name: "framework", value: "vitest" },
			],
			links: [
				{
					name: "GitHub Actions run",
					url: "https://github.example/getkimchi/kimchi/actions/runs/12345/attempts/2",
				},
			],
		})
		expect(results[0].statusDetails).toEqual(statusDetails)
		expect(results[0].uuid).toBe(
			readdirSync(resultsDir)[0].replace(/-result\.json$/, ""),
		)
	})
})

describe("failed Allure Vitest results", () => {
	let root: string

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "kimchi-vitest-allure-failure-"))
	})

	afterEach(() => {
		rmSync(root, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	it("writes the first error message and stack", () => {
		const resultsDir = join(root, "results")
		const reporter = new AllureVitestReporter({ resultsDir })
		const error = Object.assign(new Error("expected 200, received 500"), {
			stack: "AssertionError: expected 200, received 500\nstack",
		})

		reporter.onTestCaseResult(fakeTestCase({ state: "failed", error }))

		expect(readResults(resultsDir)[0]).toMatchObject({
			status: "failed",
			statusDetails: {
				message: "expected 200, received 500",
				trace: "AssertionError: expected 200, received 500\nstack",
			},
		})
	})

	it("swallows write errors and warns on stderr only once", () => {
		const resultsFile = join(root, "not-a-directory")
		writeFileSync(resultsFile, "file blocks mkdir")
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
		const reporter = new AllureVitestReporter({ resultsDir: resultsFile })

		expect(() => {
			reporter.onTestCaseResult(fakeTestCase({ state: "passed" }))
			reporter.onTestCaseResult(fakeTestCase({ state: "passed" }))
		}).not.toThrow()
		expect(stderr).toHaveBeenCalledTimes(1)
		expect(stderr.mock.calls[0][0]).toContain("[allure-vitest-reporter] result delivery disabled:")
	})
})
