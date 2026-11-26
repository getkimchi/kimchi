import { createHash, randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

const MAX_ATTACHMENT_BYTES = 1024 * 1024
const TRUNCATION_MARKER = "\n\n[log truncated to 1 MiB]\n"

export function listFailLogs(dir) {
	return readdirSync(dir)
		.filter((name) => name.includes(".fail.") && name.endsWith(".tui-e2e.log"))
		.map((name) => join(dir, name))
		.sort()
}

export function newFailLogs(before, after) {
	const existing = new Set(before)
	return after.filter((path) => !existing.has(path))
}

/** Write one native Allure result for an entire test file, not for its individual test cases. */
export function writeTuiAllureResult({ resultsDir, stem, exitCode, start, stop, failLogPaths = [], failureMessage }) {
	const fullName = `tests/e2e/tui/${stem}.test.ts`
	const identity = createHash("sha256").update(fullName).digest("hex")
	const uuid = randomUUID()
	const flaky = exitCode === 0 && failLogPaths.length > 0
	mkdirSync(resultsDir, { recursive: true })
	const statusDetails =
		exitCode === 0
			? flaky
				? {
						flaky: true,
						message: `passed after ${failLogPaths.length} failed attempt${failLogPaths.length === 1 ? "" : "s"}`,
					}
				: undefined
			: failureStatusDetails({ exitCode, failLogPaths, failureMessage })
	const runUrl = githubRunUrl()
	const result = {
		uuid,
		historyId: identity,
		testCaseId: identity,
		fullName,
		name: stem,
		status: exitCode === 0 ? "passed" : "failed",
		...(statusDetails ? { statusDetails } : {}),
		...(failLogPaths.length > 0 ? { attachments: failLogPaths.map((path) => writeAttachment(resultsDir, path)) } : {}),
		...(runUrl ? { links: [{ name: "GitHub Actions run", url: runUrl }] } : {}),
		stage: "finished",
		start,
		stop,
	}
	writeFileSync(join(resultsDir, `${uuid}-result.json`), `${JSON.stringify(result, null, 2)}\n`)
}

function failureStatusDetails({ exitCode, failLogPaths, failureMessage }) {
	const fallback = failureMessage ?? `tui-test exited with code ${exitCode}`
	if (failLogPaths.length === 0) return { message: fallback }

	const log = readFileSync(failLogPaths[0], "utf8")
	const errorSection = /(?:^|\r?\n)## Error\r?\n\r?\n([\s\S]*?)(?=\r?\n\r?\n## |$)/.exec(log)?.[1]?.trim()
	if (!errorSection) return { message: fallback }

	const message = errorSection.split(/\r?\n\r?\n/, 1)[0].trim()
	return {
		message,
		...(errorSection !== message ? { trace: errorSection } : {}),
	}
}

function writeAttachment(resultsDir, logPath) {
	const source = `${randomUUID()}-attachment.log`
	const contents = readFileSync(logPath)
	writeFileSync(join(resultsDir, source), contents.subarray(0, MAX_ATTACHMENT_BYTES))
	if (contents.length > MAX_ATTACHMENT_BYTES) appendFileSync(join(resultsDir, source), TRUNCATION_MARKER)
	return { name: basename(logPath), source, type: "text/plain" }
}

function githubRunUrl() {
	const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } = process.env
	if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID || !GITHUB_RUN_ATTEMPT) return undefined
	return `${GITHUB_SERVER_URL.replace(/\/$/, "")}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT}`
}
