import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it, onTestFinished } from "vitest"

const ROOT = fileURLToPath(new URL("../../../", import.meta.url))

it("loads the embedded worker and executes a script in the compiled binary", { timeout: 90_000 }, () => {
	const outputDir = mkdtempSync(join(tmpdir(), "codemode-worker-entrypoint-"))
	onTestFinished(() => rmSync(outputDir, { recursive: true, force: true }))
	const binary = join(outputDir, process.platform === "win32" ? "worker-test.exe" : "worker-test")
	execFileSync(
		"bun",
		[
			"scripts/compile-binary.js",
			"./src/codemode-worker-entrypoint.harness.ts",
			"./src/extensions/codemode/worker.ts",
			"--outfile",
			binary,
		],
		{ cwd: ROOT, encoding: "utf8", timeout: 60_000 },
	)
	const output = execFileSync(binary, [], { cwd: outputDir, encoding: "utf8", timeout: 25_000 })
	const result = JSON.parse(output.trim().split("\n").at(-1)!) as {
		workerUrl: string
		result: { ok: boolean; value?: unknown }
	}
	expect(result.workerUrl).toBe("./src/extensions/codemode/worker.ts")
	expect(result.result.ok, JSON.stringify(result)).toBe(true)
	expect(result.result.value).toBe(42)
})
