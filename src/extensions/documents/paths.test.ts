import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { sameFile } from "./paths.js"

describe("sameFile", () => {
	it("rejects identical spellings", () => {
		expect(sameFile("a/b.pptx", "a/b.pptx")).toBe(true)
	})

	it("resolves relative vs absolute spellings of the same file", () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-paths-"))
		try {
			writeFileSync(join(dir, "x.pptx"), "x")
			expect(sameFile(join(dir, "x.pptx"), join(dir, ".", "x.pptx"))).toBe(true)
			expect(sameFile(join(dir, "x.pptx"), join(dir, "y.pptx"))).toBe(false)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("follows symlinks: a link and its target are the same file", () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-paths-"))
		try {
			writeFileSync(join(dir, "real.pptx"), "x")
			symlinkSync(join(dir, "real.pptx"), join(dir, "link.pptx"))
			expect(sameFile(join(dir, "link.pptx"), join(dir, "real.pptx"))).toBe(true)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("handles a not-yet-existing --out under a symlinked directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-paths-"))
		try {
			symlinkSync(dir, join(dir, "alias"))
			writeFileSync(join(dir, "in.pptx"), "x")
			// out "alias/out.pptx" does not exist yet, but its dir resolves to dir.
			expect(sameFile(join(dir, "alias", "out.pptx"), join(dir, "out.pptx"))).toBe(true)
			expect(sameFile(join(dir, "alias", "out.pptx"), join(dir, "other.pptx"))).toBe(false)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
