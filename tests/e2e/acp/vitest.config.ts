// Vitest config for ACP integration tests. Each test spawns a real kimchi
// binary and writes to its own temp HOME/workdir, so run serially.

import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		include: ["tests/e2e/acp/**/*.test.ts"],
		fileParallelism: false,
		testTimeout: 120_000,
	},
})
