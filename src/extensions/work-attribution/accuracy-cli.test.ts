import { execFile } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as config from "../../config.js"
import { createContext } from "../__mocks__/context.js"
import { appendWorkRecord, getWorkId } from "../work-attribution.js"
import type { AttributionLabel } from "./accuracy.js"
import { runCli } from "./accuracy-cli.js"
import { captureBillingSource, reconcileWorkCosts } from "./cost-sync.js"
import type { RequestCostAllocation } from "./costs.js"
import { flushWorkSummaries } from "./summary.js"

vi.mock("../../config.js", async (original) => ({ ...(await original<typeof config>()) }))

const execFileAsync = promisify(execFile)
const scriptPath = fileURLToPath(new URL("./accuracy-cli.ts", import.meta.url))
const tsxPath = join(process.cwd(), "node_modules", ".bin", "tsx")

const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-accuracy-cli-"))

afterAll(() => {
	rmSync(tempRoot, { recursive: true, force: true })
})

const PR1 = "github:acme/api#1"
const PR7 = "github:acme/api#7"
const PR9 = "github:acme/api#9"

function row(requestId: string, overrides: Partial<RequestCostAllocation> = {}): RequestCostAllocation {
	return {
		requestId,
		account: {
			apiUrl: "https://api.example.test",
			organizationId: "11111111-1111-4111-8111-111111111111",
			userId: "22222222-2222-4222-8222-222222222222",
		},
		workIds: [`work-${requestId}`],
		sessionIds: [`session-${requestId}`],
		startedAt: "2026-01-15T10:00:00.000Z",
		pullRequestIds: [],
		allocation: "unlinked",
		billingRecordIds: [`billing-${requestId}`],
		priceStatus: "priced",
		knownCostUsd: "0.000000000",
		totalCostUsd: overrides.knownCostUsd ?? "0.000000000",
		...overrides,
	}
}

function label(requestId: string, expectedPullRequestId: string | null): AttributionLabel {
	return { requestId, expectedPullRequestId }
}

/** Five priced rows: confident correct, confidently wrong, shared, unmerged (both missed) and null-labeled confident. */
function validRows(): RequestCostAllocation[] {
	return [
		row("req-correct", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" }),
		row("req-wrong", { allocation: "pull-request", pullRequestIds: [PR9], knownCostUsd: "2.000000000" }),
		row("req-shared", { allocation: "shared", pullRequestIds: [PR1], knownCostUsd: "0.500000000" }),
		row("req-unmerged", { allocation: "unmerged", pullRequestIds: [PR1], knownCostUsd: "0.250000000" }),
		row("req-nullconf", { allocation: "pull-request", pullRequestIds: [PR7], knownCostUsd: "3.000000000" }),
	]
}

function validLabels(): AttributionLabel[] {
	return [
		label("req-correct", PR1),
		label("req-wrong", PR1),
		label("req-shared", PR1),
		label("req-unmerged", PR1),
		label("req-nullconf", null),
	]
}

/** Amounts verified against node -e bigint math; wrong exceeds the reference via null-labeled confident spending. */
const EXPECTED_AMOUNTS = [
	"Reference: 3.750000000 USD (4 requests)",
	"Correct: 1.000000000 USD (1 requests)",
	"Wrong: 5.000000000 USD (2 requests)",
	"Missed: 2.750000000 USD (3 requests)",
]
const EXPECTED_PERCENTAGES = ["Correct coverage: 26.666666666%", "Wrong assignment: 83.333333333%"]
const OVERLAP_NOTE =
	"Wrong assignment divides wrong spending by assigned spending. Correct coverage divides correct spending by spending expected on a PR."
const USAGE = "Usage: pnpm exec tsx src/extensions/work-attribution/accuracy-cli.ts <report.json> <labels.json>"

type CliSpawnError = Error & { code: number | string | undefined; stdout: string; stderr: string }

/** Run the documented command with the caller's environment intact. */
function spawnCli(args: readonly string[]) {
	return execFileAsync(tsxPath, [scriptPath, ...args], { timeout: 120_000 })
}

async function expectSpawnFailure(args: readonly string[]): Promise<CliSpawnError> {
	try {
		await spawnCli(args)
	} catch (error) {
		return error as CliSpawnError
	}
	throw new Error(`expected a non-zero exit for args ${JSON.stringify(args)}`)
}

/** Write a fixture file; a string value is written verbatim (for deliberately broken JSON). */
function writeFixture(name: string, value: unknown): string {
	const path = join(tempRoot, name)
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, "\t"))
	return path
}

describe("accuracy-cli (spawned via tsx)", () => {
	it("exits 0 and prints the complete summary for a valid report and labels", async () => {
		const reportPath = writeFixture("valid-report.json", {
			pullRequests: [],
			requests: validRows(),
			unallocated: {},
			generatedAt: "2026-01-15T10:00:00.000Z",
		})
		const labelsPath = writeFixture("valid-labels.json", validLabels())

		const { stdout } = await spawnCli([reportPath, labelsPath])
		const lines = stdout.trimEnd().split("\n")
		expect(lines[0]).toBe("Work-attribution accuracy comparison")
		expect(stdout).toContain(
			"Label-only comparison: accounts, prices and aggregate totals are not independently checked.",
		)
		for (const expected of EXPECTED_AMOUNTS) expect(stdout).toContain(expected)
		for (const expected of EXPECTED_PERCENTAGES) expect(stdout).toContain(expected)
		// Amount lines precede the percentage lines.
		expect(lines.findIndex((line) => line.startsWith(EXPECTED_PERCENTAGES[0]))).toBeGreaterThan(
			lines.indexOf(EXPECTED_AMOUNTS[0]),
		)
		expect(stdout).toContain(OVERLAP_NOTE)
		expect(lines.at(-1)).toBe("Complete")
	})

	it("exits 1 naming the path when the report file is unreadable", async () => {
		const missingPath = join(tempRoot, "does-not-exist.json")
		const labelsPath = writeFixture("unreadable-labels.json", validLabels())

		const error = await expectSpawnFailure([missingPath, labelsPath])
		expect(error.code).toBe(1)
		expect(error.stderr).toContain(missingPath)
		expect(error.stderr).toMatch(/no such file/i)
	})

	it("exits 2 with listed problems and suppressed percentages for duplicate labels", async () => {
		const reportPath = writeFixture("duplicate-report.json", {
			requests: [row("req-dup", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" })],
		})
		const labelsPath = writeFixture("duplicate-labels.json", [label("req-dup", PR1), label("req-dup", PR1)])

		const error = await expectSpawnFailure([reportPath, labelsPath])
		expect(error.code).toBe(2)
		const lines = error.stdout.trimEnd().split("\n")
		expect(lines.at(-1)).toBe("Incomplete — 1 problems; full percentages unavailable")
		expect(error.stdout).toContain("Problems (1):")
		expect(error.stdout).toContain("[duplicate-label]")
		expect(error.stdout).toContain("req-dup")
		expect(error.stdout).toContain("Percentages: full percentages unavailable (comparison incomplete)")
		// Known subtotals are still reported even though every percentage is suppressed.
		expect(error.stdout).toContain("Reference: 0.000000000 USD (0 requests)")
	})
})

describe("runCli (in-process)", () => {
	it("does not exit successfully for an entirely unlabelled report", () => {
		const reportPath = writeFixture("unlabelled-report.json", {
			requests: [row("req-unlabelled", { knownCostUsd: "1.000000000" })],
		})
		const labelsPath = writeFixture("unlabelled-labels.json", [])

		expect(runCli([reportPath, labelsPath]).code).toBe(2)
	})

	it("exits incomplete when a real CLI invocation scores only USD 1 of USD 10", async () => {
		const reportPath = writeFixture("partial-label-report.json", {
			requests: [
				row("req-labelled", { allocation: "pull-request", pullRequestIds: [PR1], knownCostUsd: "1.000000000" }),
				row("req-unlabelled", { allocation: "pull-request", pullRequestIds: [PR7], knownCostUsd: "9.000000000" }),
			],
		})
		const labelsPath = writeFixture("partial-label-labels.json", [label("req-labelled", PR1)])

		const error = await expectSpawnFailure([reportPath, labelsPath])
		expect(error.code).toBe(2)
		expect(error.stdout).toContain("req-unlabelled")
	})

	it("exits 1 with the usage line for wrong argument counts", () => {
		for (const argv of [[], ["only-report.json"], ["report.json", "labels.json", "extra.json"]]) {
			const outcome = runCli(argv)
			expect(outcome.code).toBe(1)
			expect(outcome.stdout).toEqual([])
			expect(outcome.stderr).toEqual([USAGE])
		}
	})

	it("exits 1 naming the path when a file cannot be read", () => {
		const missingPath = join(tempRoot, "unit-missing.json")
		const outcome = runCli([missingPath, join(tempRoot, "unit-missing-labels.json")])
		expect(outcome.code).toBe(1)
		expect(outcome.stdout).toEqual([])
		expect(outcome.stderr).toHaveLength(1)
		expect(outcome.stderr[0]).toContain(missingPath)
		expect(outcome.stderr[0]).toMatch(/no such file/i)
	})

	it("exits 1 naming the path when the report is not valid JSON", () => {
		const reportPath = writeFixture("unit-broken.json", "{ not json")
		const labelsPath = writeFixture("unit-empty-labels.json", [])

		const outcome = runCli([reportPath, labelsPath])
		expect(outcome.code).toBe(1)
		expect(outcome.stderr).toHaveLength(1)
		expect(outcome.stderr[0]).toContain(reportPath)
		expect(outcome.stderr[0]).toMatch(/parse/i)
	})

	it("exits 1 when the report is not an object with a requests array", () => {
		const arrayReportPath = writeFixture("unit-array-report.json", [])
		const noRequestsReportPath = writeFixture("unit-no-requests-report.json", { pullRequests: [] })
		const labelsPath = writeFixture("unit-empty-labels-2.json", [])

		for (const reportPath of [arrayReportPath, noRequestsReportPath]) {
			const outcome = runCli([reportPath, labelsPath])
			expect(outcome.code).toBe(1)
			expect(outcome.stderr).toHaveLength(1)
			expect(outcome.stderr[0]).toContain(reportPath)
			expect(outcome.stderr[0]).toMatch(/requests/)
		}
	})

	it("exits 1 when the labels file is not an array", () => {
		const reportPath = writeFixture("unit-report.json", { requests: validRows() })
		const labelsPath = writeFixture("unit-object-labels.json", {
			requestId: "req-correct",
			expectedPullRequestId: PR1,
		})

		const outcome = runCli([reportPath, labelsPath])
		expect(outcome.code).toBe(1)
		expect(outcome.stderr).toHaveLength(1)
		expect(outcome.stderr[0]).toContain(labelsPath)
		expect(outcome.stderr[0]).toMatch(/array/i)
	})

	it("exits 0 with the zero-reference note when a complete comparison has no reference spending", () => {
		const reportPath = writeFixture("unit-zero-ref-report.json", {
			requests: [
				row("req-u1", { allocation: "unlinked", knownCostUsd: "1.000000000" }),
				row("req-u2", { allocation: "shared", pullRequestIds: [PR1], knownCostUsd: "2.000000000" }),
			],
		})
		const labelsPath = writeFixture("unit-zero-ref-labels.json", [label("req-u1", null), label("req-u2", null)])

		const outcome = runCli([reportPath, labelsPath])
		expect(outcome.code).toBe(0)
		expect(outcome.stderr).toEqual([])
		const lines = outcome.stdout
		expect(lines[0]).toBe("Work-attribution accuracy comparison")
		// Null-labeled non-confident rows land in no bucket, so every subtotal is exactly zero.
		expect(lines).toContain("Reference: 0.000000000 USD (0 requests)")
		expect(lines).toContain("Correct coverage: n/a (zero spending denominator); n/a (zero request denominator)")
		expect(lines).toContain(OVERLAP_NOTE)
		expect(lines.at(-1)).toBe("Complete")
	})
})

describe("accuracy-cli as a script", { timeout: 30_000 }, () => {
	it("still reads its inputs when VITEST is inherited from a parent process", async () => {
		const outcome = await execFileAsync(
			process.execPath,
			["--import", "tsx", scriptPath, join(tempRoot, "missing-report.json"), join(tempRoot, "missing-reference.json")],
			{ env: { ...process.env, VITEST: "true" }, timeout: 20_000 },
		).then(
			() => ({ code: 0 }),
			(error: CliSpawnError) => ({ code: error.code }),
		)
		expect(outcome.code).toBe(1)
	})
})

describe("scoring a saved costs.json", () => {
	const api = "https://billing.example/api"
	const organizationId = "33333333-2222-4333-8444-555555555555"
	const userId = "11111111-2222-4333-8444-555555555555"
	const pullRequestId = "github:github.com/example/repo#1"
	let agentDir: string
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "kimchi-accuracy-saved-"))
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir)
		const original = config.loadConfig()
		const endpoints = config.resolveEndpoints()
		vi.spyOn(config, "loadConfig").mockImplementation(() => ({ ...original, apiKey: "test-only-key" }))
		vi.spyOn(config, "resolveEndpoints").mockReturnValue({
			...endpoints,
			platformApiUrl: api,
			openAiBaseUrl: "https://gateway.example/openai/v1",
			llmEndpoint: "https://gateway.example/openai/v1",
		})
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) =>
				String(input).endsWith("api-keys:verify")
					? Response.json({ organizationId, userId })
					: Response.json({
							items: [{ id: "22222222-2222-4333-8444-555555555555", promptId: userId, totalPrice: "0.123456789" }],
							nextPageCursor: "",
						}),
			),
		)
	})
	afterEach(async () => {
		await flushWorkSummaries()
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		rmSync(agentDir, { recursive: true, force: true })
	})

	it("certifies a correct costs.json written by the cost reconciler against a matching reference", async () => {
		const ctx = createContext({ cwd: agentDir, sessionManager: { getSessionId: () => "session" } })
		const workId = getWorkId(ctx)
		appendWorkRecord(ctx, {
			type: "request",
			requestId: "request",
			startedAt: "2026-10-01T08:00:00Z",
			scope: { account: { apiUrl: api, organizationId, userId }, repository: join(agentDir, ".git") },
		})
		appendWorkRecord(ctx, {
			type: "request_response",
			requestId: "request",
			billingSource: captureBillingSource(
				new Headers({ Authorization: "Bearer test-only-key" }),
				"https://gateway.example/openai/v1/chat/completions",
				agentDir,
			),
			response: { promptId: userId },
		})
		appendWorkRecord(ctx, {
			type: "commit",
			sha: "a".repeat(40),
			repository: join(agentDir, ".git"),
			worktree: agentDir,
			pullRequests: [
				{
					provider: "github",
					host: "github.com",
					repository: "example/repo",
					number: 1,
					url: "https://github.com/example/repo/pull/1",
					state: "merged",
					headSha: "a".repeat(40),
					mergeCommitSha: "b".repeat(40),
					mergedAt: "2026-10-01T09:00:00Z",
					closedAt: "2026-10-01T09:00:00Z",
					checkedAt: "2026-10-01T10:00:00Z",
				},
			],
		})
		await reconcileWorkCosts(agentDir, new AbortController().signal)
		const reportPath = join(agentDir, "work", workId, "costs.json")
		// Independent facts: gateway receipt, verified key owner and the Git PR, not the report itself.
		const referencePath = writeFixture("saved-costs-reference.json", {
			version: 1,
			requests: [
				{
					requestId: "request",
					account: { apiUrl: api, organizationId, userId },
					costUsd: "0.123456789",
					expected: { kind: "pull-request", pullRequestId },
				},
			],
		})
		expect(runCli([reportPath, referencePath]).code).toBe(0)
	})
})
