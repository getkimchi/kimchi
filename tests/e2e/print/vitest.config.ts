// Vitest config for print-mode (headless) E2E tests. Each test spawns a real
// kimchi binary and writes to its own temp HOME/workdir, so run serially.

import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		include: ["tests/e2e/print/**/*.test.ts"],
		fileParallelism: false,
		testTimeout: 120_000,
	},
})
