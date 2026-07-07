// Remove electron-builder's packaging byproducts from dist/, leaving only
// dist/bin, dist/share, and the final packaged app artifact (e.g. the
// portable .exe on Windows).
//
// Used by build-gui.js after packaging, and can also be run standalone in CI
// right after `electron-builder` when dist/bin was already built earlier in
// the same job (avoids re-running build:binary just to get this cleanup).
//
// Usage:
//   node scripts/clean-gui-dist.js

import { existsSync, readdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

const REMOVE_NAMES = new Set([
	"electron", // raw compiled main/preload JS from gui/electron — asar-packed into the exe already
	"win-unpacked",
	"mac",
	"mac-arm64",
	"linux-unpacked",
	"linux-arm64-unpacked",
	"builder-debug.yml",
	"builder-effective-config.yaml",
])

export function cleanGuiDist() {
	console.log("\n→ clean dist (gui packaging byproducts)")

	const distDir = join(projectRoot, "dist")

	if (!existsSync(distDir)) {
		return
	}

	for (const entry of readdirSync(distDir)) {
		const shouldRemove = REMOVE_NAMES.has(entry) || entry.endsWith(".blockmap")

		if (shouldRemove) {
			console.log(`  removing dist/${entry}`)
			rmSync(join(distDir, entry), { recursive: true, force: true })
		}
	}
}

// Run immediately when invoked directly as `node scripts/clean-gui-dist.js`,
// but not when imported by build-gui.js.
const isDirectRun = process.argv[1]?.endsWith("clean-gui-dist.js")
if (isDirectRun) {
	cleanGuiDist()
}
