import { defineConfig } from "@microsoft/tui-test"

export default defineConfig({
	// TUI e2e is timing-sensitive (shell startup, async renders). Retry transient
	// failures instead of hand-tuning every wait — mirrors upstream tui-test's config.
	retries: 2,
})
