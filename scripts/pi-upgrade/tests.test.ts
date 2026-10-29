import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"
import {
	type Exec,
	missingSymbols,
	netFailures,
	parseTypecheck,
	parseVitestJson,
	rejectedPatchPackage,
	rewritePackageJson,
	runSuites,
	type SuiteResult,
	scrubEnv,
} from "./tests.ts"

const PKG = {
	dependencies: {
		"@earendil-works/pi-coding-agent": "1.3.0",
		"@earendil-works/pi-codemode": "1.3.0",
		"@earendil-works/pi-tui": "1.3.0",
		other: "1.3.0",
	},
	devDependencies: { "@earendil-works/pi-ai": "1.3.0" },
	pnpm: {
		patchedDependencies: {
			"playwright-core@1.59.1": "patches/playwright-core@1.59.1.patch",
			"@earendil-works/pi-ai@1.3.0": "patches/@earendil-works__pi-ai@1.3.0.patch",
			"@earendil-works/pi-tui@1.3.0": "patches/@earendil-works__pi-tui@1.3.0.patch",
			"@earendil-works/pi-coding-agent@1.3.0": "patches/@earendil-works__pi-coding-agent@1.3.0.patch",
		},
	},
}

describe("rewritePackageJson", () => {
	it("bumps Pi pins and re-keys applying patches, dropping the rest", () => {
		const { pkgJson, excluded, renamed } = rewritePackageJson(PKG, "1.3.0", "1.4.0", ["pi-ai", "pi-tui"])

		expect(pkgJson.dependencies).toEqual({
			"@earendil-works/pi-coding-agent": "1.4.0",
			"@earendil-works/pi-codemode": "1.4.0",
			"@earendil-works/pi-tui": "1.4.0",
			other: "1.3.0",
		})
		expect(pkgJson.devDependencies).toEqual({ "@earendil-works/pi-ai": "1.4.0" })
		expect(pkgJson.pnpm.patchedDependencies).toEqual({
			"playwright-core@1.59.1": "patches/playwright-core@1.59.1.patch",
			"@earendil-works/pi-ai@1.4.0": "patches/@earendil-works__pi-ai@1.4.0.patch",
			"@earendil-works/pi-tui@1.4.0": "patches/@earendil-works__pi-tui@1.4.0.patch",
		})
		expect(excluded).toEqual(["@earendil-works__pi-coding-agent@1.3.0.patch"])
		expect(renamed).toEqual([
			["patches/@earendil-works__pi-ai@1.3.0.patch", "patches/@earendil-works__pi-ai@1.4.0.patch"],
			["patches/@earendil-works__pi-tui@1.3.0.patch", "patches/@earendil-works__pi-tui@1.4.0.patch"],
		])
		expect(PKG.dependencies["@earendil-works/pi-tui"]).toBe("1.3.0")
	})
})

const TSC = `src/a.ts(3,10): error TS2305: Module '"@earendil-works/pi-coding-agent"' has no exported member 'ModelSelector'.
src/b.ts(12,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
src/c.ts(1,1): error TS2724: '"@earendil-works/pi-tui"' has no exported member named 'Boxx'. Did you mean 'Box'?
Found 3 errors in 3 files.
`

describe("typecheck parsing", () => {
	it("turns each tsc error into a stable id", () => {
		expect(parseTypecheck(TSC)).toEqual([
			"src/a.ts(3,10): TS2305 Module '\"@earendil-works/pi-coding-agent\"' has no exported member 'ModelSelector'.",
			"src/b.ts(12,5): TS2345 Argument of type 'string' is not assignable to parameter of type 'number'.",
			"src/c.ts(1,1): TS2724 '\"@earendil-works/pi-tui\"' has no exported member named 'Boxx'. Did you mean 'Box'?",
		])
	})

	it("strips checkout-specific node_modules paths so ids match across checkouts", () => {
		const out = `src/entry.ts(115,11): error TS2339: Property 'setEmbeddedQuickJSWasmPath' does not exist on type 'typeof import("/private/var/T/pi-upgrade-1.4.0/target/node_modules/.pnpm/@earendil-works+pi-coding-agent@1.4.0_x/node_modules/@earendil-works/pi-coding-agent/dist/index", { with: { "resolution-m...'.\n`
		expect(parseTypecheck(out)).toEqual([
			`src/entry.ts(115,11): TS2339 Property 'setEmbeddedQuickJSWasmPath' does not exist on type 'typeof import("@earendil-works/pi-coding-agent", { with: { "resolution-m...'.`,
		])
	})

	it("counts a member removed from a namespace import as a missing symbol", () => {
		const out = `src/entry.ts(115,11): error TS2339: Property 'setEmbeddedQuickJSWasmPath' does not exist on type 'typeof import("/t/node_modules/@earendil-works/pi-coding-agent/dist/index")'.\n`
		const typecheck: SuiteResult = {
			suite: "typecheck",
			status: "fail",
			failed: parseTypecheck(out),
			exitCode: 2,
			log: "",
		}
		expect(missingSymbols(typecheck)).toEqual([
			"@earendil-works/pi-coding-agent: setEmbeddedQuickJSWasmPath (src/entry.ts(115,11))",
		])
	})

	it("lists Pi symbols that no longer resolve", () => {
		const typecheck: SuiteResult = {
			suite: "typecheck",
			status: "fail",
			failed: parseTypecheck(TSC),
			exitCode: 2,
			log: "",
		}
		expect(missingSymbols(typecheck)).toEqual([
			"@earendil-works/pi-coding-agent: ModelSelector (src/a.ts(3,10))",
			"@earendil-works/pi-tui: Boxx (src/c.ts(1,1))",
		])
	})
})

describe("parseVitestJson", () => {
	it("returns failing tests and failing files relative to the checkout", () => {
		const json = {
			testResults: [
				{
					name: "/w/src/a.test.ts",
					status: "failed",
					assertionResults: [
						{ fullName: "a works", status: "passed" },
						{ fullName: "a breaks", status: "failed" },
					],
				},
				{ name: "/w/src/b.test.ts", status: "failed", assertionResults: [] },
				{ name: "/w/src/c.test.ts", status: "passed", assertionResults: [{ fullName: "c", status: "passed" }] },
			],
		}
		expect(parseVitestJson(JSON.stringify(json), "/w")).toEqual(["src/a.test.ts > a breaks", "src/b.test.ts"])
	})
})

describe("rejectedPatchPackage", () => {
	it("names the package whose patch pnpm could not apply", () => {
		const log =
			" ERR_PNPM_PATCH_FAILED  Could not apply patch /w/patches/@earendil-works__pi-tui@1.4.0.patch to /w/node_modules/.pnpm/x"
		expect(rejectedPatchPackage(log)).toBe("pi-tui")
	})

	it("returns null for an install failure unrelated to patches", () => {
		expect(rejectedPatchPackage(" ERR_PNPM_NO_MATCHING_VERSION  No matching version found")).toBeNull()
	})
})

describe("netFailures", () => {
	it("drops failures that also fail on the baseline", () => {
		const target: SuiteResult[] = [
			{ suite: "unit", status: "fail", failed: ["x", "y"], exitCode: 1, log: "t" },
			{ suite: "smoke", status: "fail", failed: ["s"], exitCode: 1, log: "t" },
		]
		const base: SuiteResult[] = [
			{ suite: "unit", status: "fail", failed: ["x"], exitCode: 1, log: "b" },
			{ suite: "smoke", status: "fail", failed: ["s"], exitCode: 1, log: "b" },
		]
		expect(netFailures(target, base).map((r) => [r.suite, r.status, r.failed])).toEqual([
			["unit", "fail", ["y"]],
			["smoke", "pass", []],
		])
	})
})

describe("runSuites", () => {
	function logDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-upgrade-tests-"))
		onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
		return dir
	}

	it("runs every TUI file separately and reports the failing ones", () => {
		const exec: Exec = (_cmd, args, { logFile }) => {
			if (args.includes("--dry-run")) {
				writeFileSync(logFile, "alpha\nbeta\n")
				return 0
			}
			writeFileSync(logFile, "")
			return args.includes("beta") ? 1 : 0
		}
		const [tui] = runSuites({ dir: "/w", suites: ["tui"], exec, logDir: logDir(), side: "target" })
		expect(tui).toMatchObject({ suite: "tui", status: "fail", failed: ["beta"] })
	})

	it("keeps going after a failing suite and records a failure id when none can be parsed", () => {
		const exec: Exec = (_cmd, args, { logFile }) => {
			writeFileSync(logFile, "boom")
			return args.includes("build:binary") ? 1 : 0
		}
		const results = runSuites({ dir: "/w", suites: ["binary", "typecheck"], exec, logDir: logDir(), side: "target" })
		expect(results.map((r) => [r.suite, r.status, r.failed])).toEqual([
			["binary", "fail", ["binary (exit 1)"]],
			["typecheck", "pass", []],
		])
	})
})

describe("scrubEnv", () => {
	it("removes write-capable tokens before running upstream code", () => {
		expect(scrubEnv({ PATH: "/bin", GH_TOKEN: "t", GITHUB_TOKEN: "t", KIMCHI_API_KEY: "k", KEEP: "1" }, [])).toEqual({
			PATH: "/bin",
			KEEP: "1",
		})
	})

	it("keeps an allowed key", () => {
		expect(scrubEnv({ GH_TOKEN: "t", KIMCHI_API_KEY: "k" }, ["KIMCHI_API_KEY"])).toEqual({ KIMCHI_API_KEY: "k" })
	})
})

describe("runSuites errors", () => {
	it("marks binary-dependent suites not-run when the binary build fails", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-upgrade-tests-"))
		onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
		const exec: Exec = (_cmd, args, { logFile }) => {
			writeFileSync(logFile, "")
			return args.includes("build:binary") ? 1 : 0
		}
		const results = runSuites({ dir: "/w", suites: ["binary", "smoke", "tui"], exec, logDir: dir, side: "target" })
		expect(results.map((r) => [r.suite, r.status])).toEqual([
			["binary", "fail"],
			["smoke", "not-run"],
			["tui", "not-run"],
		])
		expect(readFileSync(results[1].log, "utf8")).toContain("binary build failed")
	})
})
