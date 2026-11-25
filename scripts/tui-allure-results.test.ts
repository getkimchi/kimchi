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
import { expect, it } from "vitest"
import { parse } from "yaml"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const runnerPath = join(repoRoot, "scripts", "run-tui-e2e.js")
const allureResultsPath = join(repoRoot, "scripts", "tui-allure-results.js")
const githubExpression = (expression: string) => `\${{ ${expression} }}`
const allureSetupAction = "allure-framework/setup-allurectl@2d89ee0b7ba2f59dbe9849b6df5763cab78e14db"

function createTuiRunnerFixture({ missingRunner = false }: { missingRunner?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "kimchi-tui-allure-test-"))
	mkdirSync(join(root, "scripts"), { recursive: true })
	mkdirSync(join(root, "tests", "e2e", "tui"), { recursive: true })
	mkdirSync(join(root, "node_modules", ".bin"), { recursive: true })
	copyFileSync(runnerPath, join(root, "scripts", "run-tui-e2e.js"))
	copyFileSync(allureResultsPath, join(root, "scripts", "tui-allure-results.js"))
	writeFileSync(join(root, "tests", "e2e", "tui", "skip-list.js"), "export const SKIPPED_TUI_TESTS = []\n")
	writeFileSync(join(root, "tests", "e2e", "tui", "alpha.test.ts"), "")
	writeFileSync(join(root, "tests", "e2e", "tui", "beta.test.ts"), "")
	const fakeRunner = join(root, "node_modules", ".bin", "tui-test")
	if (!missingRunner) {
		writeFileSync(
			fakeRunner,
			'#!/usr/bin/env node\nconsole.log(process.argv.at(-1))\nprocess.exit(process.argv.includes("beta") ? 1 : 0)\n',
		)
		chmodSync(fakeRunner, 0o755)
	}
	return {
		root,
		resultsDir(relative: string) {
			return join(root, relative)
		},
		run(resultsDir?: string) {
			const env = { ...process.env }
			env.ALLURE_RESULTS = undefined
			if (resultsDir) env.ALLURE_RESULTS = resultsDir
			return spawnSync(process.execPath, [join(root, "scripts", "run-tui-e2e.js")], {
				cwd: root,
				env,
				encoding: "utf8",
				timeout: 10_000,
			})
		},
	}
}

function readResults(resultsDir: string) {
	return readdirSync(resultsDir)
		.filter((file) => file.endsWith("-result.json"))
		.map((file) => JSON.parse(readFileSync(join(resultsDir, file), "utf8")))
}

function requireResult<T>(result: T | undefined, name: string): T {
	expect(result, `${name} result is missing`).toBeDefined()
	if (result === undefined) throw new Error(`${name} result is missing`)
	return result
}

it.skipIf(process.platform === "win32")(
	"writes one minimal Allure result per executed file and preserves the TUI exit status",
	() => {
		const fixture = createTuiRunnerFixture()
		try {
			const firstDir = fixture.resultsDir("allure-first")
			const firstRun = fixture.run(firstDir)
			expect(firstRun.status).toBe(1)
			const first = readResults(firstDir)
			expect(first).toHaveLength(2)
			const alpha = requireResult(
				first.find((result) => result.name === "alpha"),
				"alpha",
			)
			const beta = requireResult(
				first.find((result) => result.name === "beta"),
				"beta",
			)
			expect(alpha).toMatchObject({
				name: "alpha",
				fullName: "tests/e2e/tui/alpha.test.ts",
				status: "passed",
				stage: "finished",
			})
			expect(alpha.statusDetails).toBeUndefined()
			expect(beta).toMatchObject({
				name: "beta",
				fullName: "tests/e2e/tui/beta.test.ts",
				status: "failed",
				stage: "finished",
				statusDetails: { message: "tui-test exited with code 1" },
			})
			expect(alpha.stop).toBeGreaterThanOrEqual(alpha.start)
			expect(beta.stop).toBeGreaterThanOrEqual(beta.start)

			const secondDir = fixture.resultsDir("allure-second")
			expect(fixture.run(secondDir).status).toBe(1)
			const secondAlpha = requireResult(
				readResults(secondDir).find((result) => result.name === "alpha"),
				"alpha",
			)
			expect(secondAlpha.testCaseId).toBe(alpha.testCaseId)
			expect(secondAlpha.historyId).toBe(alpha.historyId)
			expect(secondAlpha.uuid).not.toBe(alpha.uuid)

			const disabledFixture = createTuiRunnerFixture()
			try {
				expect(disabledFixture.run().status).toBe(1)
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
	},
)

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
	expect(job.env.ALLURE_UPLOAD_ENABLED).toBe(
		githubExpression(`contains(fromJSON('["push","merge_group","schedule"]'), github.event_name)`),
	)
	expect(job.env.ALLURE_RUN_KIND).toBe(
		githubExpression(
			`github.event_name == 'push' && 'master' || github.event_name == 'merge_group' && 'merge_queue' || github.event_name == 'schedule' && 'nightly' || 'other'`,
		),
	)
	expect(job.strategy.matrix).toMatchObject({
		shard: [1, 2, 3, 4],
		iteration: githubExpression(
			`github.event_name == 'schedule' && fromJSON('[1,2,3,4,5,6,7,8,9,10]') || fromJSON('[1]')`,
		),
	})

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
	const artifacts = job.steps.find((step: { name?: string }) => step.name === "Upload TUI E2E artifacts")
	expect(artifacts.with.name).toContain(githubExpression("matrix.iteration"))
})
