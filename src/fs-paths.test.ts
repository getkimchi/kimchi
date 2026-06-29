import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { expandUserPath, findExistingFile, resolveUserPath, stripAtPrefix } from "./fs-paths.js"

describe("resolveUserPath", () => {
	it("expands bare ~ to the user's home directory", () => {
		expect(resolveUserPath("~", "/any/cwd")).toBe(homedir())
	})

	it("expands ~/ prefix to home directory", () => {
		expect(resolveUserPath("~/Downloads", "/any/cwd")).toBe(resolve(homedir(), "Downloads"))
	})

	it("leaves ~ alone when not followed by / (treats as filename)", () => {
		expect(resolveUserPath("~foo", "/cwd")).toBe(resolve("/cwd", "~foo"))
	})

	it("resolves cwd-relative paths", () => {
		expect(resolveUserPath("sub/file.txt", "/base")).toBe("/base/sub/file.txt")
	})

	it("passes absolute paths through unchanged", () => {
		expect(resolveUserPath("/etc/hosts", "/any/cwd")).toBe("/etc/hosts")
	})

	it("strips a leading @", () => {
		expect(resolveUserPath("@/etc/hosts", "/any/cwd")).toBe("/etc/hosts")
	})
})

describe("stripAtPrefix / expandUserPath", () => {
	it("stripAtPrefix removes a single leading @", () => {
		expect(stripAtPrefix("@foo")).toBe("foo")
		expect(stripAtPrefix("@@foo")).toBe("@foo")
		expect(stripAtPrefix("foo")).toBe("foo")
	})

	it("expandUserPath normalizes non-ASCII spaces to regular space", () => {
		// U+00A0 (NBSP) between words should collapse to plain space.
		expect(expandUserPath("foo\u00A0bar")).toBe("foo bar")
	})
})

describe("findExistingFile", () => {
	let tmp: string
	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), "fs-paths-test-"))
		writeFileSync(join(tmp, "present.txt"), "hi")
		mkdirSync(join(tmp, "a-directory"))
	})
	afterAll(() => {
		rmSync(tmp, { recursive: true, force: true })
	})

	it("returns the absolute path for an existing file", () => {
		expect(findExistingFile("present.txt", tmp)).toBe(join(tmp, "present.txt"))
	})

	it("returns null for a missing file", () => {
		expect(findExistingFile("missing.txt", tmp)).toBe(null)
	})

	it("returns null for a directory (rejects non-files)", () => {
		expect(findExistingFile("a-directory", tmp)).toBe(null)
	})

	it("strips a leading @ before resolving", () => {
		expect(findExistingFile("@present.txt", tmp)).toBe(join(tmp, "present.txt"))
	})

	it("finds a file whose stored name uses a narrow no-break space before AM/PM", () => {
		const storedName = "Screenshot 2025-01-01 at 10.00\u202FAM.png"
		writeFileSync(join(tmp, storedName), "x")
		// Caller passes a regular space — the NNBSP variant should match.
		const queried = findExistingFile("Screenshot 2025-01-01 at 10.00 AM.png", tmp)
		expect(queried).toBe(join(tmp, storedName))
	})

	it("finds a file whose stored name uses a curly apostrophe when queried with a straight one", () => {
		const storedName = "Capture d\u2019\u00E9cran.png"
		writeFileSync(join(tmp, storedName), "x")
		const queried = findExistingFile("Capture d'\u00E9cran.png", tmp)
		expect(queried).toBe(join(tmp, storedName))
	})
})
