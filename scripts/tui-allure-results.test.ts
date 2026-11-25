import { spawnSync } from "node:child_process"
import {
	chmodSync,
	copyFileSync,
	existsSync,
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

function createTuiRunnerFixture() {
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
	writeFileSync(fakeRunner, '#!/usr/bin/env node\nprocess.exit(process.argv.includes("beta") ? 1 : 0)\n')
	chmodSync(fakeRunner, 0o755)
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
			const alpha = first.find((result) => result.name === "alpha")
			const beta = first.find((result) => result.name === "beta")
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
			const secondAlpha = readResults(secondDir).find((result) => result.name === "alpha")
			expect(secondAlpha.testCaseId).toBe(alpha.testCaseId)
			expect(secondAlpha.historyId).toBe(alpha.historyId)
			expect(secondAlpha.uuid).not.toBe(alpha.uuid)

			const withoutReporting = fixture.resultsDir("allure-disabled")
			expect(fixture.run().status).toBe(1)
			expect(existsSync(withoutReporting)).toBe(false)
		} finally {
			rmSync(fixture.root, { recursive: true, force: true })
		}
	},
)

it("configures optional non-blocking Allure uploads in the TUI workflow", () => {
	const workflow = parse(readFileSync(join(repoRoot, ".github", "workflows", "tui-e2e.yml"), "utf8"))
	const job = workflow.jobs["tui-e2e"]
	expect(job.env).toMatchObject({
		ALLURE_ENDPOINT: "https://castai.testops.cloud",
		ALLURE_PROJECT_ID: githubExpression("vars.ALLURE_PROJECT_ID"),
		ALLURE_RESULTS: "allure-results/tui",
		ALLURE_CONTINUE_ON_ERROR: "true",
	})

	const setup = job.steps.find((step: { uses?: string }) => step.uses === "allure-framework/setup-allurectl@v1")
	expect(setup).toMatchObject({
		id: "allurectl",
		if: "always() && env.ALLURE_TOKEN != '' && env.ALLURE_PROJECT_ID != ''",
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
