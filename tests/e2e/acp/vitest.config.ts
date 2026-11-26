// Vitest config for ACP integration tests. Each test spawns a real kimchi
// binary with its own temp HOME and workdir, and fake servers listen on
// port 0, so most files can run in parallel.
//
// MCP and OAuth files stay serial: an MCP OAuth flow binds the fixed
// callback port 19876 (pi-mcp-adapter), and two flows at once would collide.
// They run after the parallel group, one file at a time.

import { defineConfig } from "vitest/config"
import { withAllureReporter } from "../../setup/allure-vitest.js"

const SERIAL = ["tests/e2e/acp/mcp*.test.ts", "tests/e2e/acp/oauth*.test.ts"]

export default withAllureReporter(
	defineConfig({
		test: {
			retry: process.env.CI ? 2 : 0,
			testTimeout: 120_000,
			projects: [
				{
					extends: true,
					test: {
						name: "acp-parallel",
						include: ["tests/e2e/acp/**/*.test.ts"],
						exclude: SERIAL,
						// The runner has 4 vCPUs. Every test also runs a kimchi process.
						maxWorkers: 3,
						sequence: { groupOrder: 0 },
					},
				},
				{
					extends: true,
					test: {
						name: "acp-serial",
						include: SERIAL,
						fileParallelism: false,
						sequence: { groupOrder: 1 },
					},
				},
			],
		},
	}),
)
