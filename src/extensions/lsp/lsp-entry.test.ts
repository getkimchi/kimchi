import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { clientCwd } from "../lsp.js"
import { normalizePath } from "./utils.js"

describe("clientCwd", () => {
	it("returns sessionCwd for file inside it", () => {
		expect(clientCwd("/repo/src/foo.ts", "/repo")).toBe("/repo")
	})

	it("returns sessionCwd for file at sessionCwd root", () => {
		expect(clientCwd("/repo/foo.ts", "/repo")).toBe("/repo")
	})

	it("returns file directory for file outside sessionCwd", () => {
		// Out-of-workspace files resolve to the canonical (realpath) dirname —
		// on macOS that canonicalizes /tmp → /private/tmp.
		expect(clientCwd("/tmp/test.ts", "/repo")).toBe(path.dirname(normalizePath("/tmp/test.ts")))
	})

	it("does not match sessionCwd as prefix of unrelated path", () => {
		expect(clientCwd("/repo-other/foo.ts", "/repo")).toBe("/repo-other")
	})

	it("returns file directory for deeply nested outside file", () => {
		expect(clientCwd("/tmp/gotest/main.go", "/repo")).toBe(path.dirname(normalizePath("/tmp/gotest/main.go")))
	})

	it("matches when the session cwd is reached through a symlink", () => {
		// macOS /var → /private/var, symlinked repo dirs: the containment check
		// must resolve aliases on both sides, not compare raw strings.
		const real = mkdtempSync(path.join(tmpdir(), "lsp-cwd-"))
		const alias = `${real}-alias`
		symlinkSync(real, alias)
		writeFileSync(path.join(real, "foo.ts"), "const x = 1\n")
		try {
			// cwd given as alias, file as real path → contained.
			expect(clientCwd(path.join(real, "foo.ts"), alias)).toBe(alias)
			// cwd given as real path, file as alias path → contained.
			expect(clientCwd(path.join(alias, "foo.ts"), real)).toBe(real)
		} finally {
			rmSync(alias, { force: true })
			rmSync(real, { recursive: true, force: true })
		}
	})

	it.runIf(process.platform === "darwin" || process.platform === "win32")(
		"matches case-insensitively on case-insensitive filesystems",
		() => {
			expect(clientCwd("/REPO/src/foo.ts", "/repo")).toBe("/repo")
		},
	)
})
