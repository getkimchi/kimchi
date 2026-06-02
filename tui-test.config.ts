import { defineConfig } from "@microsoft/tui-test"

const liveLlm = process.env.KIMCHI_TUI_LIVE_LLM === "1"
const liveSubagents = process.env.KIMCHI_TUI_LIVE_SUBAGENTS === "1"

export default defineConfig({
	expect: {
		timeout: 10_000,
	},
	globalTimeout: liveSubagents ? 15 * 60_000 : liveLlm ? 10 * 60_000 : 5 * 60_000,
	retries: process.env.CI ? 1 : 0,
	testMatch: "tests/tui/**/*.tui.ts",
	timeout: liveSubagents ? 8 * 60_000 : liveLlm ? 240_000 : 90_000,
	trace: process.env.KIMCHI_TUI_TRACE === "1",
	traceFolder: ".kimchi/docs/tui-traces",
	workers: 1,
})
