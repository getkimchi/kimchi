import { defineConfig } from "@microsoft/tui-test"

export default defineConfig({
	// Retry transient startup/render races (TUI e2e is timing-sensitive).
	retries: 2,
})
