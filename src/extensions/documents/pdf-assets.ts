/**
 * Runtime assets for pdf.mjs: DejaVu TTFs live next to the bundled script
 * in `<skill>/assets/` (staged by scripts/copy-resources.js from
 * node_modules for both dev `resources/` and shipped `share/kimchi/`), so
 * the compiled binary needs no fallback plumbing. In unit tests the source
 * tree resolves them straight from node_modules.
 */

import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const FONT_FILES = {
	regular: "DejaVuSans.ttf",
	bold: "DejaVuSans-Bold.ttf",
	mono: "DejaVuSansMono.ttf",
} as const

export interface PdfFonts {
	regular: Uint8Array
	bold: Uint8Array
	mono: Uint8Array
}

/**
 * Directory holding the DejaVu TTFs. Importing from the bundled script
 * resolves `<script>/../assets/`; importing from src (tests) resolves
 * node_modules/dejavu-fonts-ttf/ttf. Returns undefined when neither exists.
 */
export function resolvePdfAssetsDir(): string | undefined {
	const here = dirname(fileURLToPath(import.meta.url))
	const bundled = join(here, "..", "assets")
	if (existsSync(join(bundled, FONT_FILES.regular))) return bundled
	try {
		const require = createRequire(import.meta.url)
		const pkg = require.resolve("dejavu-fonts-ttf/package.json")
		const dir = join(dirname(pkg), "ttf")
		if (existsSync(join(dir, FONT_FILES.regular))) return dir
	} catch {
		// package not installed — bundled dir absent too
	}
	return undefined
}
