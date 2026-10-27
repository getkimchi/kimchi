import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { findPdfFonts, pdfFontSearchDirs } from "./pdf-fonts.js"

describe("pdfFontSearchDirs", () => {
	it("prepends KIMCHI_PDF_FONT_DIR and keeps platform dirs", () => {
		const dirs = pdfFontSearchDirs({ KIMCHI_PDF_FONT_DIR: "/opt/fonts" })
		expect(dirs[0]).toBe("/opt/fonts")
		expect(dirs.length).toBeGreaterThan(1)
	})
})

describe("findPdfFonts", () => {
	it("discovers a real install (host fonts or the dev fallback)", () => {
		const dirs = [
			process.env.KIMCHI_PDF_FONT_DIR ?? "",
			"/System/Library/Fonts/Supplemental",
			"/usr/share/fonts",
			"node_modules/dejavu-fonts-ttf/ttf",
		].filter(Boolean)
		const fonts = findPdfFonts(dirs)
		if (fonts === undefined)
			throw new Error("no fonts discoverable — install Arial (macOS/Windows) or DejaVu/Liberation (Linux)")
		expect(existsSync(fonts.regular)).toBe(true)
		expect(existsSync(fonts.bold)).toBe(true)
	})

	it("finds DejaVu from the dev fallback and families in priority order", () => {
		const fonts = findPdfFonts(["node_modules/dejavu-fonts-ttf/ttf"])
		expect(fonts?.regular).toContain("DejaVuSans.ttf")
		expect(fonts?.bold).toContain("DejaVuSans-Bold.ttf")
		expect(fonts?.mono).toContain("DejaVuSansMono.ttf")
	})

	it("returns undefined for an empty directory tree", () => {
		expect(findPdfFonts(["definitely/not/a/fonts/dir"])).toBeUndefined()
	})

	it("skips monster faces (they would bloat every created PDF)", () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-fonts-"))
		try {
			writeFileSync(join(dir, "Arial.ttf"), new Uint8Array(9 * 1024 * 1024))
			writeFileSync(join(dir, "Arial Bold.ttf"), new Uint8Array(9 * 1024 * 1024))
			writeFileSync(join(dir, "DejaVuSans.ttf"), new Uint8Array(1024))
			writeFileSync(join(dir, "DejaVuSans-Bold.ttf"), new Uint8Array(1024))
			const fonts = findPdfFonts([dir])
			expect(fonts?.regular).toContain("DejaVuSans.ttf")
			expect(fonts?.bold).toContain("DejaVuSans-Bold.ttf")
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
