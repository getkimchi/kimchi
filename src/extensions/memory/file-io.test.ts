import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readMemoryFile, writeMemoryFile } from "./file-io.js"

describe("readMemoryFile", () => {
	let tmpDir: string
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "kimchi-memory-test-"))
	})
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	it("returns empty array for missing file", async () => {
		const result = await readMemoryFile(join(tmpDir, "missing.md"))
		expect(result).toEqual([])
	})

	it("splits §-delimited entries", async () => {
		const path = join(tmpDir, "test.md")
		writeFileSync(path, "Entry one.\n§\nEntry two.\n§\nEntry three.", "utf-8")
		const result = await readMemoryFile(path)
		expect(result).toEqual(["Entry one.", "Entry two.", "Entry three."])
	})
})

describe("writeMemoryFile", () => {
	let tmpDir: string
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "kimchi-memory-test-"))
	})
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	it("writes §-delimited entries atomically", async () => {
		const path = join(tmpDir, "test.md")
		await writeMemoryFile(path, ["A", "B"])
		const raw = readFileSync(path, "utf-8")
		expect(raw).toBe("A\n§\nB")
	})
})
