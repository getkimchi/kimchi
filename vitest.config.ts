import { defineConfig } from "vitest/config"
import { fileURLToPath, URL } from "node:url"

const stubPath = fileURLToPath(new URL("./src/__mocks__/earendil-clipboard-image.js", import.meta.url))

export default defineConfig({
	test: {
		env: {
			// Pin locale so toLocaleString() produces consistent comma-separated
			// numbers across developer machines and CI regardless of system locale.
			LANG: "en_US.UTF-8",
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
