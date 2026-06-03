import { defineConfig } from "vitest/config"
import { fileURLToPath, URL } from "node:url"

const stubPath = fileURLToPath(new URL("./src/__mocks__/earendil-clipboard-image.js", import.meta.url))

export default defineConfig({
	test: {
		env: {
			// initTheme() reads theme JSON files from the package dir. In test
			// environments the app is never installed, so we point PI_PACKAGE_DIR
			// at the pi-coding-agent package inside node_modules so theme files
			// are always found.
			PI_PACKAGE_DIR: fileURLToPath(
				new URL("./node_modules/@earendil-works/pi-coding-agent", import.meta.url),
			),
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