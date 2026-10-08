import { defineConfig } from "vitest/config"

// Dedicated config for the DAP real-adapter integration suite
// (`pnpm run test:dap-integration`). The root vitest.config.ts excludes
// src/extensions/dap/integration.test.ts from the main parallel run: the
// suite spawns real debug adapters (dlv, js-debug, debugpy) whose subprocesses
// are starved under a full run's worker load — js-debug flushes the debuggee's
// final stdout seconds after the terminated event, which no reasonable drain
// window can absorb. CI machines don't install the adapters, so the suite
// skips there; this config exists for dev machines that do.
export default defineConfig({
	test: {
		include: ["src/extensions/dap/integration.test.ts"],
		pool: "forks",
	},
})
