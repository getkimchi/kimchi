import { fileURLToPath, URL } from "node:url"
import { defineConfig } from "vitest/config"

const stubPath = fileURLToPath(new URL("./src/__mocks__/earendil-clipboard-image.js", import.meta.url))

export default defineConfig({
	test: {
		// Ignore git worktree copies used for bench/repro runs so targeted test
		// commands don't execute the same suite multiple times.
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"**/cypress/**",
			"**/.{idea,git,github,output,temp}/**",
			"**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*",
			"**/.tui-test/**",
			".worktrees/**",
			// TUI E2E suites run through the dedicated tui-test CLI (one file per
			// process, via `pnpm run test:e2e:tui` / scripts/run-tui-e2e.js) —
			// their test framework communicates over the worker IPC channel and
			// collides with vitest's fork-pool protocol (the deterministic
			// "Unexpected call to process.send()" crash). Never run them inside
			// plain vitest; skip them here so a bare `vitest run` from the root
			// cannot trip over them.
			"tests/e2e/**",
		],
		env: {
			// Pin locale so toLocaleString() produces consistent comma-separated
			// numbers across developer machines and CI regardless of system locale.
			LANG: "en_US.UTF-8",
			// Clear any external PI_PACKAGE_DIR override so upstream theme file
			// resolution uses its own package detection inside tests rather than
			// following a stale install prefix.
			PI_PACKAGE_DIR: "",
		},
		alias: {
			// The deep-import path used in clipboard-read.ts is not in the package's
			// exports map, so Vite cannot resolve it normally. Map it to a stub file
			// so vi.mock() can target it without a "missing specifier" error.
			"@earendil-works/pi-coding-agent/dist/utils/clipboard-image.js": stubPath,
		},
		// Isolate test files to prevent mock leakage between tests
		pool: "forks",
		// Cap the fork pool. The default (one fork per CPU core) spawns a dozen-plus full Node
		// processes on a modern laptop — each holding the transformed suite in memory, and (as
		// observed) lingering after the run finishes until the system runs out of RAM. Four
		// workers match a standard CI runner, keep local memory bounded, and still leave the
		// 500+ test files comfortably parallel. Per-invocation overrides (e.g. the pre-pr
		// workflow's --maxWorkers=1) take priority over this.
		maxWorkers: 4,
	},
})
