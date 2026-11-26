import { join } from "node:path"
import { defineConfig, mergeConfig, type ViteUserConfig } from "vitest/config"

type VitestConfig = ViteUserConfig

/** Keep ordinary test runs unchanged; add TestOps-supported JUnit output only when requested. */
export function withAllureReporter(config: VitestConfig, resultsDir = process.env.ALLURE_RESULTS): VitestConfig {
	if (!resultsDir) return config
	return mergeConfig(
		config,
		defineConfig({
			test: {
				reporters: ["default", ["junit", { outputFile: join(resultsDir, "junit.xml") }]],
			},
		}),
	)
}
