// Vitest config for RPC-mode integration tests. Each test spawns a real
// kimchi binary (`--mode rpc`) and writes to its own temp HOME/workdir, so
// run serially. Mirrors the ACP e2e config.

import { defineConfig } from "vitest/config"
import { withAllureReporter } from "../../setup/allure-vitest.js"

export default withAllureReporter(
	defineConfig({
		test: {
			include: ["tests/e2e/rpc/**/*.test.ts"],
			fileParallelism: false,
			testTimeout: 120_000,
		},
	}),
)
