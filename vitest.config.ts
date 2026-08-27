import { defineConfig } from "vitest/config"
import { fileURLToPath, URL } from "node:url"

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
			".worktrees/**",
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
	},
})
