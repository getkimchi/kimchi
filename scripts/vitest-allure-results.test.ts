import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { defineConfig } from "vitest/config"
import { parse as parseYaml } from "yaml"
import { withAllureReporter } from "../tests/setup/allure-vitest.js"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const githubExpression = (expression: string) => `\${{ ${expression} }}`
const allureSetupAction = "allure-framework/setup-allurectl@2d89ee0b7ba2f59dbe9849b6df5763cab78e14db"

it("leaves Vitest config unchanged when Allure reporting is not requested", () => {
	const config = defineConfig({ test: { setupFiles: ["./tests/setup/existing.ts"] } })
	expect(withAllureReporter(config, "")).toBe(config)
})

it("adds JUnit output without registering the native Allure runner or setup", () => {
	const config = defineConfig({ test: { setupFiles: ["./tests/setup/existing.ts"] } })
	const enabled = withAllureReporter(config, "allure-results/unit")
	expect(enabled.test?.setupFiles).toEqual(["./tests/setup/existing.ts"])
	expect(enabled.test?.reporters).toEqual(["default", ["junit", { outputFile: "allure-results/unit/junit.xml" }]])
})

it.each([
	{
		workflow: "ci.yml",
		job: "master-checks",
		resultsDir: "allure-results/vitest",
		launchName: "Vitest",
		jobUid: "vitest",
	},
	{ workflow: "acp-e2e.yml", job: "acp-e2e", resultsDir: "allure-results/acp", launchName: "ACP E2E", jobUid: "acp" },
])("reports trusted Vitest runs from $workflow / $job with event and iteration tags", ({
	workflow,
	job,
	resultsDir,
	launchName,
	jobUid,
}) => {
	const config = parseYaml(readFileSync(join(repoRoot, ".github", "workflows", workflow), "utf8"))
	const target = config.jobs[job]
	expect(target.env).toMatchObject({
		ALLURE_ENDPOINT: "https://castai.testops.cloud",
		ALLURE_PROJECT_ID: githubExpression("vars.ALLURE_PROJECT_ID"),
		ALLURE_RESULTS: githubExpression(
			`contains(fromJSON('["push","merge_group"]'), github.event_name) && '${resultsDir}' || ''`,
		),
		ALLURE_CONTINUE_ON_ERROR: "true",
		ALLURE_UPLOAD_ENABLED: githubExpression(`contains(fromJSON('["push","merge_group"]'), github.event_name)`),
		ALLURE_RUN_KIND: githubExpression(
			`github.event_name == 'push' && 'master' || github.event_name == 'merge_group' && 'merge_queue' || 'other'`,
		),
	})
	expect(target.env.ALLURE_TOKEN).toBeUndefined()
	const setup = target.steps.find((step: { uses?: string }) => step.uses === allureSetupAction)
	expect(setup).toMatchObject({
		id: "allurectl",
		if: "always() && env.ALLURE_UPLOAD_ENABLED == 'true' && env.ALLURE_TOKEN_AVAILABLE == 'true' && env.ALLURE_PROJECT_ID != ''",
		"continue-on-error": true,
		with: {
			"allure-endpoint": githubExpression("env.ALLURE_ENDPOINT"),
			"allure-project-id": githubExpression("env.ALLURE_PROJECT_ID"),
		},
	})
	const upload = target.steps.find((step: { name?: string }) => step.name === "Upload Vitest results to Allure TestOps")
	expect(upload).toMatchObject({
		if: "always() && steps.allurectl.outcome == 'success'",
		"continue-on-error": true,
	})
	expect(upload.run).toContain(`--launch-name "${launchName} $ALLURE_RUN_KIND"`)
	expect(upload.run).toContain(`--job-run-uid "$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-${jobUid}"`)
	expect(upload.run).toContain(
		'--launch-tags "commit=$GITHUB_SHA,event=$ALLURE_RUN_KIND,iteration=1,run_id=$GITHUB_RUN_ID,run_attempt=$GITHUB_RUN_ATTEMPT"',
	)
	expect(upload.run).toContain('"$ALLURE_RESULTS"')
})
