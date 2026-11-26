import { spawnSync } from "node:child_process"
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const runnerPath = join(repoRoot, "scripts", "run-tui-e2e.js")
const allureResultsPath = join(repoRoot, "scripts", "tui-allure-results.js")
const { listFailLogs, newFailLogs } = await import(new URL("./tui-allure-results.js", import.meta.url).href)
const githubExpression = (expression: string) => `\${{ ${expression} }}`
const allureSetupAction = "allure-framework/setup-allurectl@2d89ee0b7ba2f59dbe9849b6df5763cab78e14db"

interface FakeFailureLog {
	artifactName?: string
	content?: string
	size?: number
}

interface AllureResult {
	uuid: string
	historyId: string
	testCaseId: string
	fullName: string
	name: string
	status: string
	stage: string
	start: number
	stop: number
	statusDetails: { flaky?: boolean; message: string; trace?: string }
	attachments: { name: string; source: string; type: string }[]
	links: { name: string; url: string }[]
}

function createTuiRunnerFixture({
	missingRunner = false,
	failureLogs = {},
	exitCodes = { beta: 1 },
}: {
	missingRunner?: boolean
	failureLogs?: Record<string, FakeFailureLog[]>
	exitCodes?: Record<string, number>
} = {}) {
	const root = mkdtempSync(join(tmpdir(), "kimchi-tui-allure-test-"))
	mkdirSync(join(root, "scripts"), { recursive: true })
	mkdirSync(join(root, "tests", "e2e", "tui"), { recursive: true })
	mkdirSync(join(root, "node_modules", ".bin"), { recursive: true })
	copyFileSync(runnerPath, join(root, "scripts", "run-tui-e2e.js"))
	copyFileSync(allureResultsPath, join(root, "scripts", "tui-allure-results.js"))
	writeFileSync(join(root, "tests", "e2e", "tui", "skip-list.js"), "export const SKIPPED_TUI_TESTS = []\n")
	writeFileSync(join(root, "tests", "e2e", "tui", "alpha.test.ts"), "")
	writeFileSync(join(root, "tests", "e2e", "tui", "beta.test.ts"), "")
	if (failureLogs["bash-commands"]) writeFileSync(join(root, "tests", "e2e", "tui", "bash-commands.test.ts"), "")
	const fakeRunner = join(root, "node_modules", ".bin", "tui-test")
	if (!missingRunner) {
		writeFileSync(
			fakeRunner,
			[
				"#!/usr/bin/env node",
				'const { writeFileSync } = require("node:fs")',
				'const { join } = require("node:path")',
				"const stem = process.argv.at(-1)",
				"console.log(stem)",
				`const failureLogs = ${JSON.stringify(failureLogs)}`,
				`const exitCodes = ${JSON.stringify(exitCodes)}`,
				"for (const [index, log] of (failureLogs[stem] ?? []).entries()) {",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: placeholders belong to emitted fake-runner source
				"\tconst artifactName = log.artifactName ?? `${stem}-attempt-${index}`",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: placeholders belong to emitted fake-runner source
				"\tconst name = `${artifactName}.fail.${process.pid}-${Date.now()}-${index + 1}.tui-e2e.log`",
				`\twriteFileSync(join(${JSON.stringify(root)}, name), log.content ?? "x".repeat(log.size ?? 0))`,
				"}",
				"process.exit(exitCodes[stem] ?? 0)",
			].join("\n"),
		)
		chmodSync(fakeRunner, 0o755)
	}
	return {
		root,
		resultsDir(relative: string) {
			return join(root, relative)
		},
		run(resultsDir?: string, environment: NodeJS.ProcessEnv = {}) {
			const env = { ...process.env }
			for (const name of [
				"ALLURE_RESULTS",
				"GITHUB_SERVER_URL",
				"GITHUB_REPOSITORY",
				"GITHUB_RUN_ID",
				"GITHUB_RUN_ATTEMPT",
			]) {
				delete env[name]
			}
			if (resultsDir) env.ALLURE_RESULTS = resultsDir
			Object.assign(env, environment)
			return spawnSync(process.execPath, [join(root, "scripts", "run-tui-e2e.js")], {
				cwd: root,
				env,
				encoding: "utf8",
				timeout: 10_000,
			})
		},
	}
}

it("attributes differently named fail logs by spawn snapshot and excludes pre-existing logs", () => {
	const root = mkdtempSync(join(tmpdir(), "kimchi-tui-log-snapshot-"))
	try {
		const existing = join(root, "billing-low-warning.fail.previous-1.tui-e2e.log")
		writeFileSync(existing, "previous failure")
		const before = listFailLogs(root)
		const created = join(root, "bash-card-layout.fail.current-1.tui-e2e.log")
		writeFileSync(created, "failure from the bash-commands spawn")
		writeFileSync(join(root, "bash-card-layout.pass.current-1.tui-e2e.log"), "pass artifact")

		expect(newFailLogs(before, listFailLogs(root))).toEqual([created])
		expect(newFailLogs(before, before)).toEqual([])
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

function readResults(resultsDir: string): AllureResult[] {
	return readdirSync(resultsDir)
		.filter((file) => file.endsWith("-result.json"))
		.map((file) => JSON.parse(readFileSync(join(resultsDir, file), "utf8")))
}

function requireResult<T>(result: T | undefined, name: string): T {
	expect(result, `${name} result is missing`).toBeDefined()
	if (result === undefined) throw new Error(`${name} result is missing`)
	return result
}

describe("successful TUI results", () => {
	it.skipIf(process.platform === "win32")("writes plain pass results without status details or attachments", () => {
		const fixture = createTuiRunnerFixture({ exitCodes: {} })
		try {
			const firstDir = fixture.resultsDir("allure-first")
			expect(fixture.run(firstDir).status).toBe(0)
			const first = readResults(firstDir)
			expect(first).toHaveLength(2)
			const alpha = requireResult(
				first.find((result) => result.name === "alpha"),
				"alpha",
			)
			expect(alpha).toMatchObject({
				name: "alpha",
				fullName: "tests/e2e/tui/alpha.test.ts",
				status: "passed",
				stage: "finished",
			})
			expect(alpha.statusDetails).toBeUndefined()
			expect(alpha.attachments).toBeUndefined()
			expect(alpha.stop).toBeGreaterThanOrEqual(alpha.start)

			const secondDir = fixture.resultsDir("allure-second")
			expect(fixture.run(secondDir).status).toBe(0)
			const secondAlpha = requireResult(
				readResults(secondDir).find((result) => result.name === "alpha"),
				"alpha",
			)
			expect(secondAlpha.testCaseId).toBe(alpha.testCaseId)
			expect(secondAlpha.historyId).toBe(alpha.historyId)
			expect(secondAlpha.uuid).not.toBe(alpha.uuid)

			const disabledFixture = createTuiRunnerFixture({ exitCodes: {} })
			try {
				expect(disabledFixture.run().status).toBe(0)
				const resultFiles = readdirSync(disabledFixture.root, { recursive: true, encoding: "utf8" }).filter((file) =>
					file.endsWith("-result.json"),
				)
				expect(resultFiles).toEqual([])
			} finally {
				rmSync(disabledFixture.root, { recursive: true, force: true })
			}
		} finally {
			rmSync(fixture.root, { recursive: true, force: true })
		}
	})

	it.skipIf(process.platform === "win32")("marks retry-recovered passes as flaky and attaches each fail log", () => {
		const firstLog = "# Kimchi TUI E2E Artifact\n\n## Error\n\nError: first attempt failed\n\n## Scenario Steps\n"
		const secondLog = "# Kimchi TUI E2E Artifact\n\n## Error\n\nError: second attempt failed\n\n## Scenario Steps\n"
		const fixture = createTuiRunnerFixture({
			exitCodes: {},
			failureLogs: { alpha: [{ content: firstLog }, { content: secondLog }] },
		})
		try {
			const resultsDir = fixture.resultsDir("allure-flaky")
			expect(fixture.run(resultsDir).status).toBe(0)
			const result = requireResult(
				readResults(resultsDir).find((candidate) => candidate.name === "alpha"),
				"alpha",
			)
			expect(result.status).toBe("passed")
			expect(result.statusDetails).toEqual({ flaky: true, message: "passed after 2 failed attempts" })
			expect(result.attachments).toHaveLength(2)
			expect(result.attachments.map((attachment) => attachment.type)).toEqual(["text/plain", "text/plain"])
			expect(result.attachments.map((attachment) => readFileSync(join(resultsDir, attachment.source), "utf8"))).toEqual(
				[firstLog, secondLog],
			)
		} finally {
			rmSync(fixture.root, { recursive: true, force: true })
		}
	})

	it.skipIf(process.platform === "win32")("attributes fail logs whose artifact names differ from the file stem", () => {
		const log = "# Kimchi TUI E2E Artifact\n\n## Error\n\nError: bash card failed\n\n## Scenario Steps\n"
		const fixture = createTuiRunnerFixture({
			exitCodes: {},
			failureLogs: { "bash-commands": [{ artifactName: "bash-card-layout", content: log }] },
		})
		try {
			const resultsDir = fixture.resultsDir("allure-different-artifact-name")
			expect(fixture.run(resultsDir).status).toBe(0)
			const result = requireResult(
				readResults(resultsDir).find((candidate) => candidate.name === "bash-commands"),
				"bash-commands",
			)
			expect(result.statusDetails).toEqual({ flaky: true, message: "passed after 1 failed attempt" })
			expect(result.attachments).toHaveLength(1)
			expect(result.attachments[0].name).toMatch(/^bash-card-layout\.fail\..+-1\.tui-e2e\.log$/)
			expect(readFileSync(join(resultsDir, result.attachments[0].source), "utf8")).toBe(log)
		} finally {
			rmSync(fixture.root, { recursive: true, force: true })
		}
	})

	it.skipIf(process.platform === "win32")("truncates oversized log attachments and records a marker", () => {
		const fixture = createTuiRunnerFixture({
			exitCodes: {},
			failureLogs: { alpha: [{ size: 1024 * 1024 + 128 }] },
		})
		try {
			const resultsDir = fixture.resultsDir("allure-truncated")
			expect(fixture.run(resultsDir).status).toBe(0)
			const result = requireResult(
				readResults(resultsDir).find((candidate) => candidate.name === "alpha"),
				"alpha",
			)
			const attachment = readFileSync(join(resultsDir, result.attachments[0].source))
			expect(attachment.length).toBe(1024 * 1024 + Buffer.byteLength("\n\n[log truncated to 1 MiB]\n"))
			expect(attachment.subarray(0, 16).toString()).toBe("x".repeat(16))
			expect(attachment.toString("utf8", attachment.length - 30)).toContain("[log truncated to 1 MiB]")
		} finally {
			rmSync(fixture.root, { recursive: true, force: true })
		}
	})

	it.skipIf(process.platform === "win32")("adds GitHub run links only when all metadata env vars are set", () => {
		const fixture = createTuiRunnerFixture({ exitCodes: {} })
		try {
			const linkedDir = fixture.resultsDir("allure-linked")
			expect(
				fixture.run(linkedDir, {
					GITHUB_SERVER_URL: "https://github.example",
					GITHUB_REPOSITORY: "getkimchi/kimchi",
					GITHUB_RUN_ID: "12345",
					GITHUB_RUN_ATTEMPT: "2",
				}).status,
			).toBe(0)
			expect(readResults(linkedDir)[0].links).toEqual([
				{
					name: "GitHub Actions run",
					url: "https://github.example/getkimchi/kimchi/actions/runs/12345/attempts/2",
				},
			])

			const unlinkedDir = fixture.resultsDir("allure-unlinked")
			expect(fixture.run(unlinkedDir, { GITHUB_SERVER_URL: "https://github.example" }).status).toBe(0)
			expect(readResults(unlinkedDir)[0].links).toBeUndefined()
		} finally {
			rmSync(fixture.root, { recursive: true, force: true })
		}
	})
})

describe("failed TUI results", () => {
	it.skipIf(process.platform === "win32")("extracts the first fail log error and attaches the logs", () => {
		const log = [
			"# Kimchi TUI E2E Artifact",
			"## Error",
			"Error: expected terminal output",
			"Error: expected terminal output\n    at planted.test.ts:10:5",
			"## Scenario Steps",
			"(none)",
		].join("\n\n")
		const fixture = createTuiRunnerFixture({ failureLogs: { beta: [{ content: log }] } })
		try {
			const resultsDir = fixture.resultsDir("allure-failed")
			expect(fixture.run(resultsDir).status).toBe(1)
			const result = requireResult(
				readResults(resultsDir).find((candidate) => candidate.name === "beta"),
				"beta",
			)
			expect(result.status).toBe("failed")
			expect(result.statusDetails.message).toBe("Error: expected terminal output")
			expect(result.statusDetails.trace).toContain("at planted.test.ts:10:5")
			expect(result.attachments).toHaveLength(1)
			expect(readFileSync(join(resultsDir, result.attachments[0].source), "utf8")).toBe(log)
		} finally {
			rmSync(fixture.root, { recursive: true, force: true })
		}
	})
})

it.skipIf(process.platform === "win32")("reports spawn failure details without masking the failed test", () => {
	const fixture = createTuiRunnerFixture({ missingRunner: true })
	try {
		const resultsDir = fixture.resultsDir("allure-spawn-error")
		expect(fixture.run(resultsDir).status).toBe(1)
		const [result] = readResults(resultsDir)
		expect(result.statusDetails.message).toContain("spawn failed:")
		expect(result.statusDetails.message).toContain("ENOENT")
	} finally {
		rmSync(fixture.root, { recursive: true, force: true })
	}
})

it.skipIf(process.platform === "win32")("continues executing files when an Allure result cannot be written", () => {
	const fixture = createTuiRunnerFixture()
	try {
		const blockedPath = fixture.resultsDir("not-a-directory")
		writeFileSync(blockedPath, "not a directory")
		const result = fixture.run(blockedPath)
		expect(result.status).toBe(1)
		expect(result.stdout).toContain("alpha")
		expect(result.stdout).toContain("beta")
		expect(result.stderr).toContain("allure result write failed: alpha")
	} finally {
		rmSync(fixture.root, { recursive: true, force: true })
	}
})

it("configures optional non-blocking Allure uploads in the TUI workflow", () => {
	const workflow = parse(readFileSync(join(repoRoot, ".github", "workflows", "tui-e2e.yml"), "utf8"))
	const job = workflow.jobs["tui-e2e"]
	expect(job.env).toMatchObject({
		ALLURE_ENDPOINT: "https://castai.testops.cloud",
		ALLURE_PROJECT_ID: githubExpression("vars.ALLURE_PROJECT_ID"),
		ALLURE_RESULTS: "allure-results/tui",
		ALLURE_CONTINUE_ON_ERROR: "true",
	})
	expect(job.env.ALLURE_TOKEN).toBeUndefined()

	const setup = job.steps.find((step: { uses?: string }) => step.uses === allureSetupAction)
	expect(setup).toMatchObject({
		id: "allurectl",
		if: "always() && env.ALLURE_UPLOAD_ENABLED == 'true' && env.ALLURE_TOKEN_AVAILABLE == 'true' && env.ALLURE_PROJECT_ID != ''",
		"continue-on-error": true,
		with: {
			"allure-endpoint": githubExpression("env.ALLURE_ENDPOINT"),
			"allure-project-id": githubExpression("env.ALLURE_PROJECT_ID"),
		},
	})
	const upload = job.steps.find((step: { name?: string }) => step.name === "Upload TUI results to Allure TestOps")
	expect(upload).toMatchObject({
		if: "always() && steps.allurectl.outcome == 'success'",
		"continue-on-error": true,
	})
	expect(upload.run).toContain("allurectl upload")
	expect(upload.run).toContain('"$ALLURE_RESULTS"')
})

it("restricts TestOps uploads to trusted events and tags nightly repetitions", () => {
	const workflow = parse(readFileSync(join(repoRoot, ".github", "workflows", "tui-e2e.yml"), "utf8"))
	expect(workflow.on.push.branches).toEqual(["master"])
	expect(workflow.on.push["paths-ignore"]).toEqual(workflow.on.pull_request["paths-ignore"])
	expect(workflow.on.merge_group).toBeNull()
	expect(workflow.on.schedule).toEqual([{ cron: "17 3 * * *" }])

	const job = workflow.jobs["tui-e2e"]
	expect(job.env.ALLURE_UPLOAD_ENABLED).toContain(
		`contains(fromJSON('["push","merge_group","schedule"]'), github.event_name)`,
	)
	expect(job.env.ALLURE_RUN_KIND).toContain(
		`github.event_name == 'push' && 'master' || github.event_name == 'merge_group' && 'merge_queue' || github.event_name == 'schedule' && 'nightly' || 'other'`,
	)
	expect(job.strategy.matrix.shard).toEqual([1, 2, 3, 4])
	expect(job.strategy.matrix.iteration).toContain(
		`github.event_name == 'schedule' && fromJSON('[1,2,3,4,5,6,7,8,9,10]') || fromJSON('[1]')`,
	)

	const setup = job.steps.find((step: { uses?: string }) => step.uses === allureSetupAction)
	expect(setup.if).toBe(
		"always() && env.ALLURE_UPLOAD_ENABLED == 'true' && env.ALLURE_TOKEN_AVAILABLE == 'true' && env.ALLURE_PROJECT_ID != ''",
	)
	expect(job.env.ALLURE_TOKEN).toBeUndefined()
	const upload = job.steps.find((step: { name?: string }) => step.name === "Upload TUI results to Allure TestOps")
	expect(upload.run).toContain("$ALLURE_RUN_KIND")
	expect(upload.run).toContain("commit=$GITHUB_SHA")
	expect(upload.run).toContain("event=$ALLURE_RUN_KIND")
	expect(upload.run).toContain(`iteration=${githubExpression("matrix.iteration")}`)
	expect(upload.run).toContain("run_id=$GITHUB_RUN_ID")
	expect(upload.run).toContain("run_attempt=$GITHUB_RUN_ATTEMPT")
	expect(upload.run).toContain(`shard=${githubExpression("matrix.shard")}`)
	const artifacts = job.steps.find((step: { name?: string }) => step.name === "Upload TUI E2E artifacts")
	expect(artifacts.if).toBe("always()")
	expect(artifacts.with["if-no-files-found"]).toBe("ignore")
	expect(artifacts.with.name).toContain(githubExpression("matrix.iteration"))
})

it("tags ACP and Vitest uploads with GitHub run correlation", () => {
	for (const [workflowFile, jobName] of [
		["acp-e2e.yml", "acp-e2e"],
		["ci.yml", "master-checks"],
	]) {
		const workflow = parse(readFileSync(join(repoRoot, ".github", "workflows", workflowFile), "utf8"))
		const upload = workflow.jobs[jobName].steps.find(
			(step: { name?: string }) => step.name === "Upload Vitest results to Allure TestOps",
		)
		expect(upload.run).toContain("run_id=$GITHUB_RUN_ID")
		expect(upload.run).toContain("run_attempt=$GITHUB_RUN_ATTEMPT")
	}
})
