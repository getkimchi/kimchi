import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runProjectChecks, summarizeProjectChecks } from "./project-tests.js"

// All fixtures live under /tmp; we mkdir/rm-rf around each test so leaks
// between cases can't cascade. No real test suites are ever run by these
// tests — that is the whole point of the rewrite.

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "project-tests-"))
}

function rmrf(dir: string): void {
	execSync(`rm -rf ${dir}`)
}

function writePkg(dir: string, scripts: Record<string, string>): void {
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts }, null, 2))
}

function installBin(dir: string, bin: string): void {
	const binDir = join(dir, "node_modules", ".bin")
	mkdirSync(binDir, { recursive: true })
	writeFileSync(join(binDir, bin), "#!/bin/sh\necho fake\n", { mode: 0o755 })
}

describe("runProjectChecks (validation, not execution)", () => {
	let dir: string

	beforeEach(() => {
		dir = makeTmpDir()
	})

	afterEach(() => {
		rmrf(dir)
	})

	it("returns discovered:false when there is no package.json or known config", () => {
		const r = runProjectChecks(dir)
		expect(r.discovered).toBe(false)
		expect(r.anyFailed).toBe(false)
		expect(r.checks).toHaveLength(0)
	})

	it("validates a node test script when the runner binary is installed", () => {
		writePkg(dir, { test: "vitest run" })
		installBin(dir, "vitest")
		const r = runProjectChecks(dir)
		expect(r.discovered).toBe(true)
		expect(r.anyFailed).toBe(false)
		expect(r.checks).toHaveLength(1)
		const check = r.checks[0]
		expect(check.kind).toBe("test")
		expect(check.exitCode).toBe(0)
		expect(check.stdout).toContain("vitest")
		// Never executed → never timed out.
		expect(check.timedOut).toBe(false)
	})

	it("flags a node test script whose runner is missing from node_modules/.bin", () => {
		writePkg(dir, { test: "vitest run" }) // no installBin → vitest missing
		const r = runProjectChecks(dir)
		expect(r.discovered).toBe(true)
		expect(r.anyFailed).toBe(true)
		expect(r.checks[0].exitCode).toBe(1)
		expect(r.checks[0].stderr).toContain("vitest")
		expect(r.checks[0].stderr).toContain("missing")
	})

	it("flags a node test script that references no known runner", () => {
		writePkg(dir, { test: "echo nothing-to-run" })
		const r = runProjectChecks(dir)
		expect(r.discovered).toBe(true)
		expect(r.anyFailed).toBe(true)
		expect(r.checks[0].exitCode).toBe(1)
		expect(r.checks[0].stderr).toContain("known runner")
	})

	it("does not actually execute the test suite during validation", () => {
		// If validation ever shelled out, this canary file would get written
		// and we'd fail the assertion below. The script is intentionally
		// destructive-shaped (touches a sentinel) to make accidental execution
		// loud.
		const sentinel = join(dir, "DO_NOT_RUN")
		writePkg(dir, { test: `vitest run && touch ${sentinel}` })
		installBin(dir, "vitest")
		const r = runProjectChecks(dir)
		expect(r.discovered).toBe(true)
		// vitest is recognized as a runner; the rest of the line is irrelevant
		// to validation. The point: even with `&& touch <sentinel>` glued on,
		// nothing should execute.
		expect(r.checks[0].exitCode).toBe(0)
		expect(() => execSync(`test ! -e ${sentinel}`)).not.toThrow()
	})

	it("discovers multiple kinds (test + lint + typecheck) and validates each independently", () => {
		writePkg(dir, {
			test: "vitest run",
			lint: "biome check src/",
			typecheck: "tsc --noEmit",
		})
		installBin(dir, "vitest")
		installBin(dir, "biome")
		installBin(dir, "tsc")
		const r = runProjectChecks(dir)
		expect(r.discovered).toBe(true)
		expect(r.anyFailed).toBe(false)
		const kinds = r.checks.map((c) => c.kind).sort()
		expect(kinds).toEqual(["lint", "test", "typecheck"])
	})

	it("anyFailed=true if at least one kind fails validation, even when others pass", () => {
		writePkg(dir, {
			test: "vitest run",
			lint: "biome check src/", // biome bin will be missing
		})
		installBin(dir, "vitest") // test ok, lint missing
		const r = runProjectChecks(dir)
		expect(r.discovered).toBe(true)
		expect(r.anyFailed).toBe(true)
		const test = r.checks.find((c) => c.kind === "test")
		const lint = r.checks.find((c) => c.kind === "lint")
		expect(test?.exitCode).toBe(0)
		expect(lint?.exitCode).toBe(1)
	})

	it("ignores unrelated package.json scripts (build, start, etc.)", () => {
		writePkg(dir, { build: "tsc", start: "node ." })
		const r = runProjectChecks(dir)
		// No 'test' / 'lint' / 'typecheck' script ⇒ nothing to validate.
		expect(r.discovered).toBe(false)
		expect(r.checks).toHaveLength(0)
	})
})

describe("summarizeProjectChecks", () => {
	it("describes no-discovery state explicitly", () => {
		expect(summarizeProjectChecks({ cwd: "/tmp", discovered: false, anyFailed: false, checks: [] })).toBe(
			"Project checks: (none discovered)",
		)
	})

	it("renders validated/invalid markers per kind and makes 'not executed' explicit", () => {
		const summary = summarizeProjectChecks({
			cwd: "/tmp",
			discovered: true,
			anyFailed: true,
			checks: [
				{ kind: "test", command: "npm test", exitCode: 0, durationMs: 1, stdout: "", stderr: "", timedOut: false },
				{ kind: "lint", command: "npm run lint", exitCode: 1, durationMs: 1, stdout: "", stderr: "", timedOut: false },
			],
		})
		expect(summary).toContain("test=valid")
		expect(summary).toContain("lint=invalid")
		expect(summary).toContain("validated, not executed")
	})
})
