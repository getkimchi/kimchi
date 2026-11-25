import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createLocalReviewRunDirectory } from "./run-directory.js"

const temporaryDirectories: string[] = []

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixture(): { root: string; outputRoot: string; outside: string } {
	const root = mkdtempSync(join(tmpdir(), "review-run-root-"))
	const outside = join(root, "outside")
	mkdirSync(outside)
	temporaryDirectories.push(root)
	return { root, outputRoot: join(root, "review-output"), outside }
}

describe("local run directory safety", () => {
	it.skipIf(process.platform === "win32")(
		"rejects a symlinked output root without creating outside artifacts",
		async () => {
			const { root, outside } = fixture()
			const link = join(root, "review-output")
			symlinkSync(outside, link, "dir")
			await expect(createLocalReviewRunDirectory(link)).rejects.toThrow(/symlink|unsafe/)
			expect(readdirSync(outside)).toEqual([])
		},
	)

	it.skipIf(process.platform === "win32")("rejects symlinked runs before creating anything at its target", async () => {
		const { outputRoot, outside } = fixture()
		mkdirSync(outputRoot)
		symlinkSync(outside, join(outputRoot, "runs"), "dir")
		await expect(createLocalReviewRunDirectory(outputRoot)).rejects.toThrow(/symlink|unsafe/)
		expect(readdirSync(outside)).toEqual([])
	})

	it("returns a canonical run directory under a real owned root", async () => {
		const { outputRoot } = fixture()
		const runDir = await createLocalReviewRunDirectory(outputRoot)
		expect(realpathSync(runDir)).toBe(runDir)
		expect(runDir.startsWith(realpathSync(join(outputRoot, "runs")))).toBe(true)
	})
})
