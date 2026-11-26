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
	{ job: "unit", launchName: "Vitest" },
	{ job: "acp-e2e", launchName: "ACP E2E" },
])("reports $job from merge queue with TestOps launch and iteration tags", ({ job, launchName }) => {
	const config = parseYaml(readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8"))
	const target = config.jobs[job]
	expect(target.uses).toBe("./.github/workflows/_test-suite.yml")
	expect(target.with).toMatchObject({
		"allure-launch": launchName,
		"allure-upload": githubExpression("github.event_name == 'merge_group'"),
		"allure-kind": "merge_queue",
		iteration: "1",
	})

	const suite = parseYaml(readFileSync(join(repoRoot, ".github", "workflows", "_test-suite.yml"), "utf8"))
	const setup = suite.jobs.run.steps.find((step: { uses?: string }) => step.uses === allureSetupAction)
	expect(setup).toMatchObject({
		id: "allurectl",
		if: "always() && inputs.allure-upload && env.ALLURE_TOKEN_AVAILABLE == 'true' && env.ALLURE_PROJECT_ID != ''",
		"continue-on-error": true,
		with: {
			"allure-endpoint": githubExpression("env.ALLURE_ENDPOINT"),
			"allure-project-id": githubExpression("env.ALLURE_PROJECT_ID"),
		},
	})
	const upload = suite.jobs.run.steps.find(
		(step: { name?: string }) => step.name === "Upload results to Allure TestOps",
	)
	expect(upload.run).toContain(
		`--job-run-uid "$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-${githubExpression("inputs.name")}-shard-${githubExpression("matrix.shard")}"`,
	)
	expect(upload.run).toContain(
		`--launch-name "${githubExpression("inputs.allure-launch")} ${githubExpression("inputs.allure-kind")} shard`,
	)
	expect(upload.run).toContain(`event=${githubExpression("inputs.allure-kind")}`)
	expect(upload.run).toContain(
		githubExpression("inputs.iteration != '' && format(',iteration={0}', inputs.iteration) || ''"),
	)
	expect(upload.run).toContain('"$ALLURE_RESULTS"')
})
