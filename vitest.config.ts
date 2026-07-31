import { defineConfig } from "vitest/config"
import { fileURLToPath, URL } from "node:url"

const stubPath = fileURLToPath(new URL("./src/__mocks__/earendil-clipboard-image.js", import.meta.url))
const accumulatorStubPath = fileURLToPath(new URL("./src/__mocks__/earendil-output-accumulator.ts", import.meta.url))

export default defineConfig({
	test: {
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
			// Same issue for the output-accumulator deep import used by
			// process-registry.ts.
			"@earendil-works/pi-coding-agent/dist/core/tools/output-accumulator.js": accumulatorStubPath,
		},
		// Isolate test files to prevent mock leakage between tests
		pool: "forks",
	},
})
