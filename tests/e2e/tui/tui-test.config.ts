import { defineConfig } from "@microsoft/tui-test"

const retries = process.env.TUI_RETRIES === undefined ? 2 : Number(process.env.TUI_RETRIES)
if (!Number.isInteger(retries) || retries < 0) throw new Error("TUI_RETRIES must be a non-negative integer")

export default defineConfig({
	// Retry transient startup/render races (TUI e2e is timing-sensitive).
	// Flaky-fix verification explicitly sets TUI_RETRIES=0; normal runs keep 2.
	retries,
	// Ferment oneshot e2e tests drive multiple turns (bootstrap + nudge-triggered
	// follow-up) plus compaction; the default 30s is too tight for those.
	timeout: 60_000,
})
