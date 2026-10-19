/**
 * OS font discovery for the pdf skill. Nothing ships with kimchi: the CLI
 * scans the host's font directories for a known-good Unicode TTF family in
 * priority order (DejaVu → Arial Unicode → Noto Sans → Liberation Sans →
 * Arial) and embeds it fully (the fontkit TTF subsetter is broken). Set
 * KIMCHI_PDF_FONT_DIR to point at a directory of .ttf/.otf files when the
 * stock OS dirs have nothing suitable.
 *
 * Tests and other callers inject explicit dirs; the bundled script reads
 * whatever the host provides.
 */

import { type Dirent, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface PdfFontPaths {
	regular: string
	bold: string
	mono?: string
}

/** Filename patterns per family, in preference order; .ttc is skipped
 * (pdf-lib cannot embed font collections). Mono is optional.
 * (Arial Unicode is deliberately NOT a candidate: at 23 MB, full embedding
 * blows any sane output size — we can't subset, see writers/pdf.ts.) */
const FAMILY_PATTERNS: Array<{ regular: RegExp; bold?: RegExp; mono?: RegExp }> = [
	{
		regular: /^DejaVuSans\.ttf$/i,
		bold: /^DejaVuSans-Bold\.ttf$/i,
		mono: /^DejaVuSansMono\.ttf$/i,
	},
	{
		regular: /^NotoSans-Regular\.ttf$/i,
		bold: /^NotoSans-Bold\.ttf$/i,
		mono: /^NotoSansMono-Regular\.ttf$/i,
	},
	{
		regular: /^LiberationSans-Regular\.ttf$/i,
		bold: /^LiberationSans-Bold\.ttf$/i,
		mono: /^LiberationMono-Regular\.ttf$/i,
	},
	{ regular: /^Arial\.ttf$/i, bold: /^Arial Bold\.ttf$/i },
]

const MAX_DEPTH = 4
/** Skip faces larger than this at discovery — fonts are embedded whole, so a
 *  monster face means a monster PDF (Arial Unicode is 23 MB). */
const MAX_FACE_BYTES = 8 * 1024 * 1024

function* walk(dir: string, depth: number): Generator<string> {
	if (depth > MAX_DEPTH) return
	let entries: Dirent[]
	try {
		entries = readdirSync(dir, { withFileTypes: true })
	} catch {
		return
	}
	for (const entry of entries) {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) {
			yield* walk(path, depth + 1)
		} else if (/\.(ttf|otf)$/i.test(entry.name)) {
			yield path
		}
	}
}

/**
 * Directories searched, in order: $KIMCHI_PDF_FONT_DIR (if set), then the
 * platform's standard font locations.
 */
export function pdfFontSearchDirs(env: NodeJS.ProcessEnv = process.env): string[] {
	const dirs: string[] = []
	const override = env.KIMCHI_PDF_FONT_DIR
	if (override) dirs.push(override)
	switch (process.platform) {
		case "darwin":
			dirs.push(
				join(homedir(), "Library", "Fonts"),
				"/Library/Fonts",
				"/System/Library/Fonts/Supplemental",
				"/System/Library/Fonts",
			)
			break
		case "win32":
			dirs.push(join(env.SYSTEMROOT ?? "C:\\Windows", "Fonts"))
			break
		default:
			dirs.push(join(homedir(), ".local", "share", "fonts"), "/usr/local/share/fonts", "/usr/share/fonts")
			break
	}
	return dirs
}

/**
 * First known-good Unicode font family found under `dirs`, or undefined when
 * no family with at least a regular face exists (bold falls back to regular
 * when the family ships no dedicated bold face).
 */
export function findPdfFonts(dirs: string[]): PdfFontPaths | undefined {
	const byName = new Map<string, string>()
	for (const dir of dirs) {
		for (const file of walk(dir, 0)) {
			const name = (file.split(/[\\/]/).pop() ?? file).toLowerCase()
			if (byName.has(name)) continue
			try {
				if (statSync(file).size > MAX_FACE_BYTES) continue
			} catch {
				continue
			}
			byName.set(name, file)
		}
	}
	const pick = (re: RegExp | undefined): string | undefined => {
		if (!re) return undefined
		return [...byName.keys()]
			.filter((n) => re.test(n))
			.sort()
			.map((n) => byName.get(n))
			.find((p) => p !== undefined)
	}
	for (const family of FAMILY_PATTERNS) {
		const regular = pick(family.regular)
		if (!regular) continue
		return {
			regular,
			bold: pick(family.bold) ?? regular,
			mono: pick(family.mono),
		}
	}
	return undefined
}
