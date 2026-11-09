import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { droppedImagePathCandidate } from "./dropped-image-path.js"

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

let dir: string

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dropped-image-path-"))
	writeFileSync(join(dir, "cat.png"), PNG_BYTES)
	writeFileSync(join(dir, "notes.txt"), "hello")
	writeFileSync(join(dir, "my cat.jpg"), PNG_BYTES)
})

afterEach(() => {
	rmSync(dir, { recursive: true, force: true })
})

describe("droppedImagePathCandidate", () => {
	it("accepts a plain absolute path to a local image", () => {
		const match = droppedImagePathCandidate(join(dir, "cat.png"), dir)
		expect(match?.resolvedPath).toBe(join(dir, "cat.png"))
		expect(match?.image.mimeType).toBe("image/png")
	})

	it("accepts a double-quoted path with spaces", () => {
		const match = droppedImagePathCandidate(`"${join(dir, "my cat.jpg")}"`, dir)
		expect(match?.resolvedPath).toBe(join(dir, "my cat.jpg"))
		expect(match?.image.mimeType).toBe("image/jpeg")
	})

	it("accepts a single-quoted and a backtick-quoted path", () => {
		expect(droppedImagePathCandidate(`'${join(dir, "cat.png")}'`, dir)?.resolvedPath).toBe(join(dir, "cat.png"))
		expect(droppedImagePathCandidate(`\`${join(dir, "cat.png")}\``, dir)?.resolvedPath).toBe(join(dir, "cat.png"))
	})

	it("accepts a shell-escaped path (backslash-space) from a terminal drop", () => {
		const match = droppedImagePathCandidate(join(dir, "my cat.jpg").replace(" ", "\\ "), dir)
		expect(match?.resolvedPath).toBe(join(dir, "my cat.jpg"))
	})

	it("keeps backslash-alphanumeric sequences intact (Windows-style separators)", () => {
		// `\c` must stay `\c`; a Windows path with a real image extension would
		// resolve via the drive root, which does not exist here → null, but the
		// important part is the candidate was not mangled into `C:dir...`
		const escaped = droppedImagePathCandidate(`${dir.replaceAll("/", "\\").replaceAll(" ", "_")}\\cat.png`, dir)
		expect(escaped).toBeNull()
		// Sanity: same path with forward slashes does resolve.
		expect(droppedImagePathCandidate(join(dir, "cat.png"), dir)?.resolvedPath).toBe(join(dir, "cat.png"))
	})

	it("resolves a relative path against cwd", () => {
		const match = droppedImagePathCandidate("cat.png", dir)
		expect(match?.resolvedPath).toBe(join(dir, "cat.png"))
	})

	it("rejects multi-token payloads (path plus prose)", () => {
		expect(droppedImagePathCandidate(`${join(dir, "cat.png")} look at this`, dir)).toBeNull()
	})

	it("rejects two dropped files in one payload", () => {
		expect(droppedImagePathCandidate(`${join(dir, "cat.png")} ${join(dir, "cat.png")}`, dir)).toBeNull()
	})

	it("rejects multi-line payloads", () => {
		expect(droppedImagePathCandidate(`${join(dir, "cat.png")}\nhello`, dir)).toBeNull()
	})

	it("rejects non-image files", () => {
		expect(droppedImagePathCandidate(join(dir, "notes.txt"), dir)).toBeNull()
	})

	it("rejects URLs and file:// URIs", () => {
		expect(droppedImagePathCandidate("https://example.com/cat.png", dir)).toBeNull()
		expect(droppedImagePathCandidate(`file://${join(dir, "cat.png")}`, dir)).toBeNull()
	})

	it("rejects missing files silently", () => {
		expect(droppedImagePathCandidate(join(dir, "missing.png"), dir)).toBeNull()
	})

	it("rejects empty payloads", () => {
		expect(droppedImagePathCandidate("", dir)).toBeNull()
		expect(droppedImagePathCandidate("   ", dir)).toBeNull()
	})
})
