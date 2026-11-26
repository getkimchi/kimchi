import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const runner = resolve(import.meta.dirname, "run-tui-e2e.js")
const tuiDir = resolve(import.meta.dirname, "../tests/e2e/tui")

// --dry-run prints the planned files and never starts tui-test.
function dryRun(shard?: string) {
	const args = shard ? ["--shard", shard, "--dry-run"] : ["--dry-run"]
	const result = spawnSync(process.execPath, [runner, ...args], { encoding: "utf8" })
	return { status: result.status, files: result.stdout.split("\n").filter(Boolean), stderr: result.stderr }
}

describe("run-tui-e2e --shard", () => {
	it("runs every file that is not quarantined in exactly one of 6 shards", () => {
		// Without --shard the runner lists every file minus the quarantined ones.
		const expected = dryRun().files.sort()
		const planned = [1, 2, 3, 4, 5, 6].flatMap((index) => dryRun(`${index}/6`).files)
		expect(planned.sort()).toEqual(expected)
	})

	it("lists every TUI test file except the quarantined ones", () => {
		const onDisk = readdirSync(tuiDir).filter((name) => name.endsWith(".test.ts")).length
		const { files, stderr } = dryRun()
		const quarantined = stderr.split("\n").filter((line) => line.includes("[tui-e2e] SKIP")).length
		expect(files.length + quarantined).toBe(onDisk)
	})

	it("says the shard is empty when there are more shards than files", () => {
		const { status, stderr } = dryRun("999/999")
		expect(status).toBe(0)
		expect(stderr).toContain("this shard has no files")
		expect(stderr).not.toContain("quarantined; nothing to run")
	})

	it("rejects a shard outside the range", () => {
		const { status, stderr } = dryRun("7/6")
		expect(status).toBe(1)
		expect(stderr).toContain("--shard out of range")
	})
})
