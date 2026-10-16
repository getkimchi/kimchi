/**
 * Contract test for the pi-coding-agent patch hunk in
 * `patches/@earendil-works__pi-coding-agent@1.3.0.patch` that makes
 * `writeZipArchive` create bug-report archives with mode 0600.
 *
 * Bug-report zips can contain full transcripts and diagnostics; the default
 * process-umask perms (0644) made them readable by other local users while
 * upstream hardens the rest of its sensitive files (1.0.x) to 0600.
 *
 * If this test starts failing after a pin bump, check whether upstream began
 * writing the archive with explicit { mode: 0o600 } (or chmod) itself — and
 * drop the patch hunk in that case.
 */
import { mkdtempSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const zipModuleUrl = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/utils/zip.js", import.meta.url)

describe("patch: bug-report zip archives are owner-only (mode 0600)", () => {
	it("creates a new archive with mode 0600", async () => {
		const { writeZipArchive } = await import(zipModuleUrl.href)
		const dir = mkdtempSync(join(tmpdir(), "zip-mode-new-"))
		const dest = join(dir, "report.zip")
		await writeZipArchive(dest, [{ name: "a.txt", contentType: "text/plain", data: "hello" }])
		expect(statSync(dest).mode & 0o777).toBe(0o600)
	})

	it("tightens permissions when the archive path already exists with mode 0644", async () => {
		const { writeZipArchive } = await import(zipModuleUrl.href)
		const dir = mkdtempSync(join(tmpdir(), "zip-mode-existing-"))
		const dest = join(dir, "report.zip")
		writeFileSync(dest, "old", { mode: 0o644 })
		await writeZipArchive(dest, [{ name: "a.txt", contentType: "text/plain", data: "hello" }])
		expect(statSync(dest).mode & 0o777).toBe(0o600)
	})
})
