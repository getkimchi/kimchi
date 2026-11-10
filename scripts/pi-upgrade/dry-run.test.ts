import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"
import { checkPatch, splitHunks } from "./dry-run.ts"

const lines = (n: number, edit: Record<number, string> = {}, prefix: string[] = []) =>
	`${[...prefix, ...Array.from({ length: n }, (_, i) => edit[i + 1] ?? String(i + 1))].join("\n")}\n`

// Hunks written against 1..30. Target: a.js shifted by two lines (offset only), b.js changed the
// line the hunk removes (conflict), c.js changed a context line (drift), gone.js no longer exists.
const PATCH = `# Patch: header comment
#
diff --git a/dist/a.js b/dist/a.js
--- a/dist/a.js
+++ b/dist/a.js
@@ -4,3 +4,3 @@
 4
-5
+five
 6
@@ -25,3 +25,3 @@
 25
-26
+twenty-six
 27
diff --git a/dist/b.js b/dist/b.js
--- a/dist/b.js
+++ b/dist/b.js
@@ -19,3 +19,3 @@
 19
-20
+TWENTY
 21
diff --git a/dist/c.js b/dist/c.js
--- a/dist/c.js
+++ b/dist/c.js
@@ -9,3 +9,3 @@
 9
-10
+ten
 11
diff --git a/dist/gone.js b/dist/gone.js
--- a/dist/gone.js
+++ b/dist/gone.js
@@ -2,3 +2,3 @@
 2
-3
+three
 4
`

function targetDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-upgrade-dry-run-"))
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
	mkdirSync(join(dir, "dist"))
	writeFileSync(join(dir, "dist/a.js"), lines(30, {}, ["x", "y"]))
	writeFileSync(join(dir, "dist/b.js"), lines(30, { 20: "twenty" }))
	writeFileSync(join(dir, "dist/c.js"), lines(30, { 9: "nine" }))
	return dir
}

describe("splitHunks", () => {
	it("splits a patch into one self-contained patch per hunk, skipping the preamble", () => {
		const hunks = splitHunks(PATCH)
		expect(hunks.map((h) => [h.file, h.hunk])).toEqual([
			["dist/a.js", 1],
			["dist/a.js", 2],
			["dist/b.js", 1],
			["dist/c.js", 1],
			["dist/gone.js", 1],
		])
		expect(hunks[1].text).toMatch(
			/^diff --git a\/dist\/a.js b\/dist\/a.js\n--- a\/dist\/a.js\n\+\+\+ b\/dist\/a.js\n@@ -25,3/,
		)
		expect(hunks[1].text).not.toContain("five")
	})
})

describe("checkPatch", () => {
	it("reports strict, fuzzy and failing hunks against the target package", () => {
		const dir = targetDir()
		const patchFile = join(dir, "..", `${dir.split("/").pop()}.patch`)
		writeFileSync(patchFile, PATCH)
		onTestFinished(() => rmSync(patchFile, { force: true }))

		const result = checkPatch(patchFile, dir)

		expect(result.hunks).toEqual([
			{ file: "dist/a.js", hunk: 1, strict: "ok", fuzz: "ok" },
			{ file: "dist/a.js", hunk: 2, strict: "ok", fuzz: "ok" },
			{ file: "dist/b.js", hunk: 1, strict: "fail", fuzz: "fail" },
			{ file: "dist/c.js", hunk: 1, strict: "fail", fuzz: "ok" },
			{ file: "dist/gone.js", hunk: 1, strict: "fail", fuzz: "fail", missingFile: true },
		])
		expect(result.appliesStrict).toBe(false)
		expect(result.appliesFuzz).toBe(false)
	})

	it("tolerates a target file without a trailing newline, like pnpm's patcher", () => {
		const dir = targetDir()
		writeFileSync(join(dir, "dist/a.js"), lines(30).trimEnd())
		const patchFile = join(dir, "..", `${dir.split("/").pop()}-eof.patch`)
		writeFileSync(
			patchFile,
			"diff --git a/dist/a.js b/dist/a.js\n--- a/dist/a.js\n+++ b/dist/a.js\n@@ -28,3 +28,3 @@\n 28\n-29\n+twenty-nine\n 30\n",
		)
		onTestFinished(() => rmSync(patchFile, { force: true }))

		expect(checkPatch(patchFile, dir).hunks).toEqual([{ file: "dist/a.js", hunk: 1, strict: "ok", fuzz: "ok" }])
	})

	it("marks a patch that applies exactly as strict and fuzzy", () => {
		const dir = targetDir()
		const patchFile = join(dir, "..", `${dir.split("/").pop()}-ok.patch`)
		writeFileSync(patchFile, PATCH.split("diff --git a/dist/b.js")[0].replace(/^#.*\n/gm, ""))
		onTestFinished(() => rmSync(patchFile, { force: true }))

		const result = checkPatch(patchFile, dir)

		expect(result.hunks.every((h: { strict: string; fuzz: string }) => h.strict === "ok" && h.fuzz === "ok")).toBe(true)
		expect(result.appliesStrict).toBe(true)
		expect(result.appliesFuzz).toBe(true)
	})
})
