import { defineConfig, mergeConfig, type ViteUserConfig } from "vitest/config"

type VitestConfig = ViteUserConfig

/** Keep ordinary test runs unchanged; add native Allure output only when requested. */
export function withAllureReporter(config: VitestConfig, resultsDir = process.env.ALLURE_RESULTS): VitestConfig {
	if (!resultsDir) return config
	return mergeConfig(
		config,
		defineConfig({
			test: {
				setupFiles: ["allure-vitest/setup"],
				reporters: ["default", ["allure-vitest/reporter", { resultsDir }]],
			},
		}),
	)
}
