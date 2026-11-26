import { fileURLToPath } from "node:url"
import { defineConfig, mergeConfig, type ViteUserConfig } from "vitest/config"

type VitestConfig = ViteUserConfig

/**
 * Keep ordinary test runs unchanged; add native Allure results only when requested.
 * Vitest 4's public onTestCaseResult API preserves retry diagnostics without
 * allure-vitest's worker setup files or custom runner.
 */
export function withAllureReporter(config: VitestConfig, resultsDir = process.env.ALLURE_RESULTS): VitestConfig {
	if (!resultsDir) return config
	return mergeConfig(
		config,
		defineConfig({
			test: {
				reporters: [
					"default",
					[fileURLToPath(new URL("./allure-vitest-reporter.js", import.meta.url)), { resultsDir }],
				],
			},
		}),
	)
}
