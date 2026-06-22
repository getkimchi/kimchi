import { defineConfig } from "@microsoft/tui-test"

const configuredLiveTimeout = Number(process.env.KIMCHI_TUI_LIVE_TIMEOUT_MS ?? 20 * 60 * 1000)
const liveTimeout = Number.isFinite(configuredLiveTimeout) ? configuredLiveTimeout : 20 * 60 * 1000

export default defineConfig({
	timeout: process.env.KIMCHI_TUI_LIVE_EVAL === "1" ? liveTimeout + 60_000 : undefined,
	// Retry transient startup/render races (TUI e2e is timing-sensitive).
	retries: process.env.KIMCHI_TUI_LIVE_EVAL === "1" ? 0 : 2,
})
