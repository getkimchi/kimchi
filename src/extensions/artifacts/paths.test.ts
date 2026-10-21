import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resolveToolPath } from "./paths.js"

describe("resolveToolPath", () => {
	let cwd: string

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "acp-resolve-tool-path-"))
	})

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true })
	})

	it("resolves relative paths against cwd", () => {
		expect(resolveToolPath("a/b.pdf", cwd)).toBe(join(cwd, "a/b.pdf"))
	})

	it("strips the @ prefix and file:// scheme", () => {
		expect(resolveToolPath("@x.pdf", cwd)).toBe(join(cwd, "x.pdf"))
		expect(resolveToolPath(pathToFileURL(join(cwd, "y.pdf")).href, cwd)).toBe(join(cwd, "y.pdf"))
	})
})
