import { defineConfig } from "@microsoft/tui-test"

export default defineConfig({
	// Retry transient startup/render races (TUI e2e is timing-sensitive).
	retries: 2,
	// Ferment oneshot e2e tests drive multiple turns (bootstrap + nudge-triggered
	// follow-up) plus compaction; the default 30s is too tight for those.
	// The background-bash cohort spec (bash-background-cohort.test.ts) waits for
	// the real 15s handoff + 60s review clock, so it needs ~75s of scenario time.
	timeout: 150_000,
})
