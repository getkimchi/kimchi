/**
 * PDF.js data assets resolution (CMaps + standard fonts).
 *
 * unpdf resolves these from the local pdfjs-dist package in dev, but a
 * compiled binary has no node_modules — the tabs are staged by
 * scripts/copy-resources.js into share/kimchi/pdfjs/ and resolved here via
 * the same auxiliary-files resolver used for themes and skills. Extraction
 * uses useSystemFonts: false so text does NOT depend on host fonts, which is
 * what makes dev and binary output identical on every target (doctor proves
 * it per-platform).
 */

import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { join } from "node:path"
import { resolveAuxiliaryFilesDir } from "../../auxiliary-files/resolver.js"
import { DocumentError } from "./model.js"

export interface PdfjsAssets {
	cMapUrl: string
	cMapPacked: boolean
	standardFontDataUrl: string
	/** "share/kimchi" (binary) or "node_modules/pdfjs-dist" (dev) — doctor reports which. */
	source: string
}

function tryDir(dir: string, source: string): PdfjsAssets | undefined {
	const cMaps = join(dir, "cmaps")
	const fonts = join(dir, "standard_fonts")
	// Directory presence suffices: pdfjs-dist version differences rename
	// individual files, and PDF.js errors surface via typed extraction errors.
	if (existsSync(cMaps) && existsSync(fonts)) {
		return { cMapUrl: `${cMaps}/`, standardFontDataUrl: `${fonts}/`, cMapPacked: true, source }
	}
	return undefined
}

export function resolvePdfjsAssets(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
	execPath: string = process.execPath,
): PdfjsAssets {
	// 1. Packaged layout (compiled binary or installed dev share dir).
	const shareDir = resolveAuxiliaryFilesDir(env, home, execPath)
	const fromShare = tryDir(join(shareDir, "pdfjs"), "share/kimchi/pdfjs")
	if (fromShare) return fromShare

	// 2. Plain dev/test: pdfjs-dist from node_modules.
	try {
		const require = createRequire(import.meta.url)
		for (const candidate of ["pdfjs-dist/package.json", "pdfjs-dist/build/pdf.mjs"]) {
			try {
				const resolved = require.resolve(candidate)
				const fromNodeModules = tryDir(
					join(resolved, "..", candidate.endsWith(".mjs") ? ".." : "."),
					"node_modules/pdfjs-dist",
				)
				if (fromNodeModules) return fromNodeModules
			} catch {
				// try the next candidate
			}
		}
	} catch {
		// fall through to the typed error
	}
	throw new DocumentError(
		"extraction-failed",
		"PDF.js data assets (cmaps/standard_fonts) not found. In a packaged install they ship under share/kimchi/pdfjs/.",
		"pdf",
	)
}
