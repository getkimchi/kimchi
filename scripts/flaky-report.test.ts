import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const { apiShape, classify, getAllPages, runReport } = await import(new URL("./flaky-report.js", import.meta.url).href)

interface TestRecord {
	testKey: string
	fullName: string
	status: "passed" | "failed"
	flaky: boolean
	commit: string | null
	runId: string | null
	runAttempt: string | null
	launchId: number
	resultId: number
	message: string | null
	createdAt: number
}

function record(overrides: Partial<TestRecord> = {}): TestRecord {
	return {
		testKey: "test-1",
		fullName: "tests/e2e/tui/example.test.ts",
		status: "passed",
		flaky: false,
		commit: "abc123",
		runId: "123",
		runAttempt: "1",
		launchId: 10,
		resultId: 20,
		message: null,
		createdAt: 1_700_000_000_000,
		...overrides,
	}
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe("classify detected outcomes", () => {
	const cases = [
		{
			name: "explicit flaky flag on a retry-recovered planted result",
			records: [record({ fullName: "zz-planted-flaky", flaky: true })],
			flakyNames: ["zz-planted-flaky"],
			failingNames: [],
			assert(stats: { flakyFlagCount: number; mixedCommitCount: number }) {
				expect(stats.flakyFlagCount).toBe(1)
				expect(stats.mixedCommitCount).toBe(0)
			},
		},
		{
			name: "passed and failed results on one commit",
			records: [
				record({ resultId: 20, status: "failed", message: "assertion failed" }),
				record({ resultId: 21, status: "passed" }),
			],
			flakyNames: ["tests/e2e/tui/example.test.ts"],
			failingNames: [],
			assert(stats: { mixedCommitCount: number; failures: number }) {
				expect(stats.mixedCommitCount).toBe(1)
				expect(stats.failures).toBe(1)
			},
		},
		{
			name: "persistent failure with no pass on its commit",
			records: [
				record({ fullName: "bash-commands.test.ts", resultId: 20, status: "failed", message: "card timeout" }),
				record({ fullName: "bash-commands.test.ts", resultId: 21, status: "failed", message: "card timeout" }),
			],
			flakyNames: [],
			failingNames: ["bash-commands.test.ts"],
			assert(stats: { totalRuns: number; failures: number; failureRate: number; failureMessages: string[] }) {
				expect(stats).toMatchObject({ totalRuns: 2, failures: 2, failureRate: 1, failureMessages: ["card timeout"] })
			},
		},
		{
			name: "stable passing result",
			records: [record()],
			flakyNames: [],
			failingNames: [],
			assert: undefined,
		},
		{
			name: "multiple commits where one is mixed",
			records: [
				record({ resultId: 20, status: "failed", commit: "mixed" }),
				record({ resultId: 21, status: "passed", commit: "mixed" }),
				record({ resultId: 22, status: "failed", commit: "other" }),
			],
			flakyNames: ["tests/e2e/tui/example.test.ts"],
			failingNames: [],
			assert(stats: { mixedCommitCount: number; failureCommitCount: number; totalRuns: number }) {
				expect(stats).toMatchObject({ mixedCommitCount: 1, failureCommitCount: 1, totalRuns: 3 })
			},
		},
	]

	it.each(cases)("$name", ({ records, flakyNames, failingNames, assert }) => {
		const report = classify(records)
		expect(report.flaky.map((test: TestRecord) => test.fullName)).toEqual(flakyNames)
		expect(report.failing.map((test: TestRecord) => test.fullName)).toEqual(failingNames)
		if (assert) assert(report.flaky[0] ?? report.failing[0])
	})
})

describe("classify edge cases and malformed records", () => {
	it("returns empty tables for empty input", () => {
		expect(classify([])).toEqual({ flaky: [], failing: [], skipped: 0 })
	})

	it("skips and counts records with missing commit tags", () => {
		expect(classify([record({ commit: null, status: "failed" })])).toEqual({ flaky: [], failing: [], skipped: 1 })
		expect(classify([record({ commit: null, flaky: true })])).toEqual({ flaky: [], failing: [], skipped: 1 })
	})

	it.each([
		null,
		record({ testKey: "" }),
		record({ status: "skipped" as "passed" }),
		record({ createdAt: Number.NaN }),
	])("skips malformed record %# without aborting classification", (malformed) => {
		expect(classify([malformed])).toEqual({ flaky: [], failing: [], skipped: 1 })
	})
})

describe("pagination safeguards", () => {
	it("stops on an empty page even when last is false", async () => {
		const client = { get: vi.fn(async () => ({ content: [], last: false, totalPages: 500 })) }
		expect(await getAllPages(client, "/api/rs/launch/__search", {})).toEqual([])
		expect(client.get).toHaveBeenCalledTimes(1)
	})

	it("rejects clearly at the 200-page cap", async () => {
		const client = {
			get: vi.fn(async (_path: string, params: { page: number }) => ({
				content: [{ id: params.page }],
				last: false,
				totalPages: 500,
			})),
		}
		await expect(getAllPages(client, "/api/rs/launch/__search", {})).rejects.toThrow(
			"Pagination limit of 200 pages exceeded for /api/rs/launch/__search",
		)
		expect(client.get).toHaveBeenCalledTimes(200)
	})
})

describe("public artifact redaction", () => {
	it("preserves probe shapes and allowlisted metadata without exposing raw values", () => {
		const shaped = apiShape(
			{
				content: [
					{
						name: "TUI E2E experiment shard 1/4 iteration 1",
						createdDate: 123456,
						createdBy: { name: "Sensitive User", email: "person@example.com" },
						tags: [{ id: 7, name: "event=experiment" }],
						status: "failed",
						statusDetails: { flaky: true, message: "sensitive failure detail" },
					},
				],
				totalPages: 12,
				totalElements: 24,
				number: 0,
				size: 1,
				numberOfElements: 1,
			},
			"launch",
		)
		const launch = shaped.content.items[0]
		expect(shaped.content).toMatchObject({ $type: "array", length: 1 })
		expect(shaped).toMatchObject({ totalPages: 12, totalElements: 24, number: 0, size: 1, numberOfElements: 1 })
		expect(launch.name).toBe("TUI E2E experiment shard 1/4 iteration 1")
		expect(launch.createdDate).toBe(123456)
		expect(launch.status).toBe("failed")
		expect(launch.statusDetails).toEqual({ flaky: true, message: "<string len=24>" })
		expect(launch.createdBy.name).toBe("<string len=14>")
		expect(launch.createdBy.email).toMatch(/^<string len=\d+>$/)
		expect(launch.tags.items[0]).toEqual({ id: "<number>", name: "event=experiment" })
		expect(JSON.stringify(shaped)).not.toContain("Sensitive User")
		expect(JSON.stringify(shaped)).not.toContain("person@example.com")
		expect(JSON.stringify(shaped)).not.toContain("sensitive failure detail")
	})

	it("does not reflect the OAuth error response body", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {})
		const operation = runReport({
			env: {
				ALLURE_ENDPOINT: "https://testops.example",
				ALLURE_TOKEN: "[REDACTED-GENERIC_SECRET]",
				ALLURE_PROJECT_ID: "42",
				FLAKY_OUT_DIR: join(tmpdir(), "unused-flaky-report"),
			},
			fetchImpl: async () => new Response("secret-reflected-token in response", { status: 401 }),
		})
		await expect(operation).rejects.toThrow("OAuth token exchange failed: HTTP 401")
		await expect(operation).rejects.not.toThrow("secret-reflected-token in response")
	})
})

describe("report mode", () => {
	it("normalizes probe-shaped API pages and writes JSON, markdown, and the GitHub summary", async () => {
		const root = mkdtempSync(join(tmpdir(), "kimchi-flaky-report-"))
		const summaryPath = join(root, "github-summary.md")
		const logs = vi.spyOn(console, "log").mockImplementation(() => {})
		const env = {
			ALLURE_ENDPOINT: "https://testops.example",
			ALLURE_TOKEN: "[REDACTED-GENERIC_SECRET]",
			ALLURE_PROJECT_ID: "42",
			FLAKY_EVENTS: "experiment",
			FLAKY_OUT_DIR: join(root, "out"),
			GITHUB_STEP_SUMMARY: summaryPath,
			GITHUB_SERVER_URL: "https://github.example",
			GITHUB_REPOSITORY: "getkimchi/kimchi",
		}
		const launch = {
			id: 101,
			createdDate: Date.parse("2026-11-26T07:00:00Z"),
			tags: [
				{ id: 1, name: "commit=abc123" },
				{ id: 2, name: "event=experiment" },
				{ id: 3, name: "run_id=45702964790" },
				{ id: 4, name: "run_attempt=1" },
			],
		}
		const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(input instanceof Request ? input.url : String(input))
			if (url.pathname === "/api/uaa/oauth/token") return jsonResponse({ access_token: "secret-bearer" })
			if (url.pathname === "/api/rs/launch/__search") {
				expect(url.searchParams.get("projectId")).toBe("42")
				expect(url.searchParams.get("rql")).toMatch(/^createdDate >= \d+$/)
				return jsonResponse(page([launch]))
			}
			if (url.pathname === "/api/rs/launch") return jsonResponse(page([launch]))
			if (url.pathname === "/api/rs/testresult") {
				expect(url.searchParams.get("launchId")).toBe("101")
				return jsonResponse(
					page([
						{
							id: 501,
							fullName: "tests/e2e/tui/zz-planted-flaky.test.ts",
							status: "passed",
							createdDate: launch.createdDate,
						},
						{
							id: 502,
							fullName: "tests/e2e/tui/bash-commands.test.ts",
							status: "failed",
							createdDate: launch.createdDate,
						},
					]),
				)
			}
			if (url.pathname === "/api/rs/testresult/501") {
				return jsonResponse({
					id: 501,
					fullName: "tests/e2e/tui/zz-planted-flaky.test.ts",
					status: { name: "passed" },
					execution: { flaky: true, statusDetails: { message: "passed after 1 failed attempt" } },
					createdDate: launch.createdDate,
				})
			}
			if (url.pathname === "/api/rs/testresult/502") {
				return jsonResponse({
					id: 502,
					fullName: "tests/e2e/tui/bash-commands.test.ts",
					status: "failed",
					statusDetails: { flaky: false, message: "Expected bash card to render" },
					createdDate: launch.createdDate,
				})
			}
			return new Response("not found", { status: 404 })
		})

		try {
			const report = await runReport({
				env,
				fetchImpl: fetchImpl as typeof fetch,
				now: () => Date.parse("2026-11-26T08:00:00Z"),
			})
			expect(report.flaky.map((test: TestRecord) => test.fullName)).toEqual(["tests/e2e/tui/zz-planted-flaky.test.ts"])
			expect(report.failing.map((test: TestRecord) => test.fullName)).toEqual(["tests/e2e/tui/bash-commands.test.ts"])
			expect(report.flaky[0].flakyFlagCount).toBe(1)
			expect(report.failing[0].failureMessages).toEqual(["Expected bash card to render"])
			expect(report.flaky[0].links.map((link: { url: string }) => link.url)).toEqual([
				"https://testops.example/project/42/test-results/501",
				"https://github.example/getkimchi/kimchi/actions/runs/45702964790/attempts/1",
			])

			const json = JSON.parse(readFileSync(join(root, "out", "flaky-report.json"), "utf8"))
			expect(json.flaky).toHaveLength(1)
			expect(json.failing).toHaveLength(1)
			expect(json.generatedAt).toBeUndefined()
			expect(json).toMatchObject({
				windowHours: 48,
				events: ["experiment"],
				launchCount: 1,
				resultCount: 2,
				skipped: 0,
			})
			expect(json.flaky[0].firstSeen).toBeUndefined()
			const markdown = readFileSync(join(root, "out", "flaky-report.md"), "utf8")
			expect(markdown).toContain("Window: 48h")
			expect(markdown).toContain("Launches scanned: 1")
			expect(markdown).toContain("Results scanned: 2")
			expect(markdown).toContain("Records skipped: 0")
			expect(markdown).not.toContain("First seen")
			expect(markdown).toContain("## Flaky")
			expect(markdown).toContain("zz-planted-flaky.test.ts")
			expect(markdown).toContain("## Persistently failing")
			expect(markdown).toContain("bash-commands.test.ts")
			expect(readFileSync(summaryPath, "utf8")).toBe(markdown)
			const logged = logs.mock.calls.flat().join("\n")
			expect(logged).not.toContain("secret-api-token")
			expect(logged).not.toContain("secret-bearer")
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	it("follows totalPages when launch pages are smaller than the requested size", async () => {
		const root = mkdtempSync(join(tmpdir(), "kimchi-flaky-pagination-"))
		const launches = [
			{ id: 201, resultId: 601, fullName: "tests/e2e/tui/zz-planted-flaky.test.ts", status: "passed", flaky: true },
			{ id: 202, resultId: 602, fullName: "tests/e2e/tui/bash-commands.test.ts", status: "failed", flaky: false },
		].map((item) => ({
			...item,
			createdDate: Date.parse("2026-11-26T07:00:00Z"),
			tags: [{ name: "event=experiment" }, { name: "commit=abc123" }],
		}))
		const launchPages: number[] = []
		const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(input instanceof Request ? input.url : String(input))
			if (url.pathname === "/api/uaa/oauth/token") return jsonResponse({ access_token: "test-bearer" })
			if (url.pathname === "/api/rs/launch/__search") {
				const pageNumber = Number(url.searchParams.get("page"))
				launchPages.push(pageNumber)
				return jsonResponse({
					content: [launches[pageNumber]],
					number: pageNumber,
					size: 1,
					totalPages: 2,
					last: pageNumber === 1,
				})
			}
			if (url.pathname === "/api/rs/launch") return jsonResponse(page(launches))
			const launch = launches.find((item) => url.searchParams.get("launchId") === String(item.id))
			if (url.pathname === "/api/rs/testresult" && launch) {
				return jsonResponse(
					page([
						{ id: launch.resultId, fullName: launch.fullName, status: launch.status, createdDate: launch.createdDate },
					]),
				)
			}
			const detailLaunch = launches.find((item) => url.pathname === `/api/rs/testresult/${item.resultId}`)
			if (detailLaunch) {
				return jsonResponse({
					id: detailLaunch.resultId,
					fullName: detailLaunch.fullName,
					status: detailLaunch.status,
					statusDetails: { flaky: false },
					...(detailLaunch.status === "passed" ? { message: "passed after 1 failed attempt" } : {}),
					createdDate: detailLaunch.createdDate,
				})
			}
			return new Response("not found", { status: 404 })
		})

		try {
			const report = await runReport({
				env: {
					ALLURE_ENDPOINT: "https://testops.example",
					ALLURE_TOKEN: "[REDACTED-GENERIC_SECRET]",
					ALLURE_PROJECT_ID: "42",
					FLAKY_EVENTS: "experiment",
					FLAKY_OUT_DIR: join(root, "out"),
				},
				fetchImpl: fetchImpl as typeof fetch,
				now: () => Date.parse("2026-11-26T08:00:00Z"),
			})
			expect(launchPages).toEqual([0, 1])
			expect(report.flaky.map((test: TestRecord) => test.fullName)).toEqual([launches[0].fullName])
			expect(report.failing.map((test: TestRecord) => test.fullName)).toEqual([launches[1].fullName])
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})
})

function page(content: unknown[]) {
	return { content, number: 0, size: 100, totalElements: content.length, totalPages: 1, last: true }
}

function jsonResponse(value: unknown) {
	return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } })
}
