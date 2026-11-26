import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Reporter, TestCase, TestError } from "vitest/node"
import { githubRunUrl } from "../../scripts/tui-allure-results.js"

const MAX_TRACE_LENGTH = 64 * 1024

interface ReporterOptions {
	resultsDir: string
}

/** Main-process-only Allure writer; unlike setup-file integrations, it cannot crash fork workers. */
export default class AllureVitestReporter implements Reporter {
	private warned = false

	constructor(private readonly options: ReporterOptions) {}

	onTestCaseResult(testCase: TestCase): void {
		try {
			this.writeResult(testCase)
		} catch (error) {
			if (this.warned) return
			this.warned = true
			const message = error instanceof Error ? error.message : String(error)
			process.stderr.write(`[allure-vitest-reporter] result delivery disabled: ${message}\n`)
		}
	}

	private writeResult(testCase: TestCase): void {
		const result = testCase.result()
		const diagnostic = testCase.diagnostic()
		const file = testCase.module.relativeModuleId.replaceAll("\\", "/")
		const fullName = `${file} > ${testCase.fullName}`
		const identity = createHash("sha256").update(fullName).digest("hex")
		const start = diagnostic?.startTime ?? Date.now()
		const firstError = result.errors?.[0]
		const statusDetails = getStatusDetails(result.state, diagnostic?.retryCount ?? 0, firstError)
		const runUrl = githubRunUrl()
		const uuid = randomUUID()

		mkdirSync(this.options.resultsDir, { recursive: true })
		writeFileSync(
			join(this.options.resultsDir, `${uuid}-result.json`),
			`${JSON.stringify(
				{
					uuid,
					historyId: identity,
					testCaseId: identity,
					fullName,
					name: testCase.name,
					status: result.state === "pending" ? "broken" : result.state,
					...(statusDetails ? { statusDetails } : {}),
					...(runUrl ? { links: [{ name: "GitHub Actions run", url: runUrl }] } : {}),
					labels: [
						{ name: "suite", value: testCase.parent.type === "suite" ? testCase.parent.fullName : file },
						{ name: "parentSuite", value: file },
						{ name: "framework", value: "vitest" },
					],
					stage: "finished",
					start,
					stop: start + (diagnostic?.duration ?? 0),
				},
				null,
				2,
			)}\n`,
		)
	}
}

function getStatusDetails(state: string, retryCount: number, error: TestError | undefined) {
	if (state === "passed" && retryCount > 0) {
		return {
			flaky: true,
			message: `passed after ${retryCount} failed attempt${retryCount === 1 ? "" : "s"}`,
			...(error ? { trace: truncate(error.stack ?? error.message) } : {}),
		}
	}
	if (state === "failed") {
		return {
			message: error?.message ?? "Test failed without an error",
			...(error ? { trace: truncate(error.stack ?? error.message) } : {}),
		}
	}
	return undefined
}

function truncate(trace: string): string {
	return trace.length <= MAX_TRACE_LENGTH ? trace : `${trace.slice(0, MAX_TRACE_LENGTH)}\n[trace truncated]`
}
