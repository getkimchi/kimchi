import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		include: ["tests/e2e/print/**/*.test.ts"],
		fileParallelism: false,
		testTimeout: 120_000,
	},
})
