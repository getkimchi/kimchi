import { defineConfig } from "@microsoft/tui-test"

export default defineConfig({
	// Retry transient startup/render races (TUI e2e is timing-sensitive).
	retries: 2,
	// Ferment oneshot e2e tests drive multiple turns (bootstrap + nudge-triggered
	// follow-up) plus compaction; the default 30s is too tight for those.
	timeout: 60_000,
})
