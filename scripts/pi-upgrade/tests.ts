import { execFileSync, spawnSync } from "node:child_process"
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { type RunConfig, readJson, type Suite, writeJson } from "./config.ts"
import type { PatchResult } from "./dry-run.ts"
import type { SettleResult } from "./settle.ts"

export interface SuiteResult {
	suite: Suite
	status: "pass" | "fail" | "not-run"
	/** Stable failure ids, comparable between the baseline and target checkouts. */
	failed: string[]
	exitCode: number | null
	log: string
}

export interface TestsResult {
	install: { ok: boolean; log: string }
	/** Patches left out of the target install because they don't apply (pnpm refuses otherwise). */
	excludedPatches: string[]
	target: SuiteResult[]
	baseline: SuiteResult[]
	/** Target failures minus those already failing on the baseline. */
	net: SuiteResult[]
	missingSymbols: string[]
}

/** Runs a command with stdout+stderr going to `logFile`; returns the exit code. */
export type Exec = (cmd: string, args: string[], opts: { cwd: string; logFile: string }) => number

const nodeExec: Exec = (cmd, args, { cwd, logFile }) => {
	const fd = openSync(logFile, "w")
	try {
		return spawnSync(cmd, args, { cwd, stdio: ["ignore", fd, fd], env: process.env }).status ?? 1
	} finally {
		closeSync(fd)
	}
}

type PackageJson = {
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
	pnpm?: { patchedDependencies?: Record<string, string> } & Record<string, unknown>
} & Record<string, unknown>

const PI_SCOPE = "@earendil-works/"

/**
 * Bumps every Pi pin from `baseline` to `target` and re-keys the Pi patches. Patches for packages
 * not in `applying` are dropped, since pnpm aborts the install on a patch that does not apply.
 */
export function rewritePackageJson<T extends PackageJson>(
	pkgJson: T,
	baseline: string,
	target: string,
	applying: string[],
): { pkgJson: T; excluded: string[]; renamed: Array<[string, string]> } {
	const next = structuredClone(pkgJson)
	for (const deps of [next.dependencies, next.devDependencies]) {
		for (const name of Object.keys(deps ?? {})) {
			if (deps && name.startsWith(PI_SCOPE) && deps[name] === baseline) deps[name] = target
		}
	}
	const excluded: string[] = []
	const renamed: Array<[string, string]> = []
	const patched = next.pnpm?.patchedDependencies
	if (patched) {
		for (const [key, file] of Object.entries(patched)) {
			const match = new RegExp(`^${PI_SCOPE}(.+)@${baseline.replaceAll(".", "\\.")}$`).exec(key)
			if (!match) continue
			delete patched[key]
			if (applying.includes(match[1])) {
				const newFile = file.replace(`@${baseline}.patch`, `@${target}.patch`)
				patched[`${PI_SCOPE}${match[1]}@${target}`] = newFile
				renamed.push([file, newFile])
			} else {
				excluded.push(file.split("/").pop() ?? file)
			}
		}
	}
	return { pkgJson: next, excluded, renamed }
}

/** `/any/path/node_modules/@scope/pkg/dist/index` → `@scope/pkg`, so ids match across checkouts. */
function normalizeModulePaths(message: string): string {
	return message.replace(/\/[^"'\s]*\/node_modules\/(@[\w-]+\/[\w-]+)(?:\/[^"'\s]*)?/g, "$1")
}

/** `file(line,col): TSxxxx message` per tsc error. */
export function parseTypecheck(output: string): string[] {
	return [...output.matchAll(/^(.+?\(\d+,\d+\)): error (TS\d+): (.*)$/gm)].map(
		([, loc, code, msg]) => `${loc}: ${code} ${normalizeModulePaths(msg)}`,
	)
}

const MISSING_EXPORT =
	/^(.+?): TS(?:2305|2614|2724) .*?"(@earendil-works\/[^"]+)"'? has no exported member(?: named)? '([^']+)'/
const MISSING_NAMESPACE_MEMBER =
	/^(.+?): TS2339 Property '([^']+)' does not exist on type 'typeof import\("(@earendil-works\/[^"]+)"/

/** Pi exports our imports reference that the target no longer has. */
export function missingSymbols(typecheck: SuiteResult): string[] {
	return typecheck.failed.flatMap((id) => {
		const exp = MISSING_EXPORT.exec(id)
		if (exp) return [`${exp[2]}: ${exp[3]} (${exp[1]})`]
		const ns = MISSING_NAMESPACE_MEMBER.exec(id)
		return ns ? [`${ns[3]}: ${ns[2]} (${ns[1]})`] : []
	})
}

/** Package whose patch pnpm refused (`ERR_PNPM_PATCH_FAILED ... @earendil-works__<pkg>@<ver>.patch`). */
export function rejectedPatchPackage(installLog: string): string | null {
	return /ERR_PNPM_PATCH_FAILED.*?@earendil-works__([\w-]+)@/.exec(installLog)?.[1] ?? null
}

interface VitestJson {
	testResults?: Array<{
		name: string
		status: string
		assertionResults?: Array<{ fullName: string; status: string }>
	}>
}

export function parseVitestJson(json: string, root: string): string[] {
	const report = JSON.parse(json) as VitestJson
	return (report.testResults ?? []).flatMap((file) => {
		const name = relative(root, file.name)
		const failing = (file.assertionResults ?? []).filter((a) => a.status === "failed")
		if (failing.length > 0) return failing.map((a) => `${name} > ${a.fullName}`)
		return file.status === "failed" ? [name] : []
	})
}

export function netFailures(target: SuiteResult[], baseline: SuiteResult[]): SuiteResult[] {
	return target.map((t) => {
		const base = baseline.find((b) => b.suite === t.suite)
		if (!base || t.status === "not-run") return t
		const known = new Set(base.failed)
		const failed = t.failed.filter((id) => !known.has(id))
		return { ...t, failed, status: failed.length > 0 ? "fail" : "pass" }
	})
}

/** Suites that exercise the compiled binary; pointless when `binary` failed. */
const NEEDS_BINARY: Suite[] = ["smoke", "tui", "acp", "mcp"]

const vitest = (config: string | null, out: string) => [
	"exec",
	"vitest",
	"run",
	...(config ? ["--config", config] : ["--dir", "src"]),
	"--reporter=json",
	`--outputFile=${out}`,
]

const MCP_PARTS = ["test:e2e:mcp:tui", "test:e2e:mcp:acp", "test:e2e:mcp:conformance"]

export function runSuites(input: {
	dir: string
	suites: Suite[]
	exec: Exec
	logDir: string
	side: "base" | "target"
}): SuiteResult[] {
	const { dir, exec, logDir, side } = input
	mkdirSync(logDir, { recursive: true })
	const logOf = (name: string) => join(logDir, `${side}-${name}.log`)
	let binaryOk = true

	const runOne = (suite: Suite): SuiteResult => {
		const log = logOf(suite)
		if (NEEDS_BINARY.includes(suite) && !binaryOk) {
			writeFileSync(log, "not run: binary build failed\n")
			return { suite, status: "not-run", failed: [], exitCode: null, log }
		}
		const vitestSuite = (config: string | null): { code: number; failed: string[] } => {
			const out = join(logDir, `${side}-${suite}.json`)
			const code = exec("pnpm", vitest(config, out), { cwd: dir, logFile: log })
			return { code, failed: existsSync(out) ? parseVitestJson(readFileSync(out, "utf8"), dir) : [] }
		}
		let code: number
		let failed: string[] = []
		switch (suite) {
			case "typecheck":
				code = exec("pnpm", ["run", "typecheck"], { cwd: dir, logFile: log })
				failed = parseTypecheck(readFileSync(log, "utf8"))
				break
			case "unit":
				;({ code, failed } = vitestSuite(null))
				break
			case "binary":
				code = exec("pnpm", ["run", "build:binary"], { cwd: dir, logFile: log })
				binaryOk = code === 0
				break
			case "smoke":
				;({ code, failed } = vitestSuite("tests/smoke/vitest.config.ts"))
				break
			case "acp":
				;({ code, failed } = vitestSuite("tests/e2e/acp/vitest.config.ts"))
				break
			case "tui": {
				// One run per file so a failure is attributable to a test file.
				code = exec("node", ["scripts/run-tui-e2e.js", "--dry-run"], { cwd: dir, logFile: log })
				const stems = readFileSync(log, "utf8")
					.split("\n")
					.filter((s) => /^[\w-]+$/.test(s))
				for (const stem of stems) {
					if (exec("node", ["scripts/run-tui-e2e.js", stem], { cwd: dir, logFile: logOf(`tui-${stem}`) }) !== 0) {
						failed.push(stem)
					}
				}
				code = failed.length > 0 ? 1 : code
				break
			}
			case "mcp":
				for (const part of MCP_PARTS) {
					if (exec("pnpm", ["run", part], { cwd: dir, logFile: logOf(part.replaceAll(":", "-")) }) !== 0) {
						failed.push(part)
					}
				}
				code = failed.length > 0 ? 1 : 0
				break
		}
		if (code !== 0 && failed.length === 0) failed = [`${suite} (exit ${code})`]
		return { suite, status: code === 0 ? "pass" : "fail", failed, exitCode: code, log }
	}

	return input.suites.map(runOne)
}

function worktree(repoRoot: string, path: string): void {
	rmSync(path, { recursive: true, force: true })
	execFileSync("git", ["-C", repoRoot, "worktree", "add", "--detach", "--force", path, "HEAD"], { stdio: "ignore" })
}

function removeWorktree(repoRoot: string, path: string): void {
	spawnSync("git", ["-C", repoRoot, "worktree", "remove", "--force", path], { stdio: "ignore" })
	rmSync(path, { recursive: true, force: true })
}

export async function runTests(cfg: RunConfig, exec: Exec = nodeExec): Promise<TestsResult> {
	const { baseline, target } = readJson<SettleResult>(cfg, "settle")
	if (!target) throw new Error("no target version: nothing to test")
	const dryRun = readJson<PatchResult[]>(cfg, "dry-run")
	const logDir = join(cfg.outDir, "logs")
	mkdirSync(logDir, { recursive: true })
	const root = join(tmpdir(), `pi-upgrade-${target}`)
	const baseDir = join(root, "base")
	const targetDir = join(root, "target")

	try {
		worktree(cfg.repoRoot, baseDir)
		const baseInstall = exec("pnpm", ["install", "--frozen-lockfile"], {
			cwd: baseDir,
			logFile: join(logDir, "base-install.log"),
		})
		const baselineResults =
			baseInstall === 0
				? runSuites({ dir: baseDir, suites: cfg.suites, exec, logDir, side: "base" })
				: cfg.suites.map(
						(suite): SuiteResult => ({
							suite,
							status: "not-run",
							failed: [],
							exitCode: null,
							log: join(logDir, "base-install.log"),
						}),
					)

		worktree(cfg.repoRoot, targetDir)
		const pkgPath = join(targetDir, "package.json")
		const original = JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson
		// pnpm's patcher needs exact context (offsets are fine), so fuzz-only patches are left out.
		let applying = dryRun.filter((p) => p.appliesStrict).map((p) => p.pkg)
		let installLog = ""
		let install = 1
		let excluded: string[] = []
		// pnpm aborts on the first patch it rejects; drop it and retry until install succeeds.
		for (let attempt = 1; attempt <= dryRun.length + 1; attempt++) {
			const rewritten = rewritePackageJson(original, baseline, target, applying)
			excluded = rewritten.excluded
			for (const [from, to] of rewritten.renamed) copyFileSync(join(targetDir, from), join(targetDir, to))
			writeFileSync(pkgPath, `${JSON.stringify(rewritten.pkgJson, null, "\t")}\n`)
			installLog = join(logDir, `target-install-${attempt}.log`)
			install = exec("pnpm", ["install", "--no-frozen-lockfile"], { cwd: targetDir, logFile: installLog })
			const rejected = install === 0 ? null : rejectedPatchPackage(readFileSync(installLog, "utf8"))
			if (!rejected || !applying.includes(rejected)) break
			applying = applying.filter((pkg) => pkg !== rejected)
		}

		const targetResults =
			install === 0
				? runSuites({ dir: targetDir, suites: cfg.suites, exec, logDir, side: "target" })
				: cfg.suites.map(
						(suite): SuiteResult => ({ suite, status: "not-run", failed: [], exitCode: null, log: installLog }),
					)
		const typecheck = targetResults.find((r) => r.suite === "typecheck")
		const result: TestsResult = {
			install: { ok: install === 0, log: installLog },
			excludedPatches: excluded,
			target: targetResults,
			baseline: baselineResults,
			net: netFailures(targetResults, baselineResults),
			missingSymbols: typecheck ? missingSymbols(typecheck) : [],
		}
		writeJson(cfg, "tests", result)
		return result
	} finally {
		removeWorktree(cfg.repoRoot, baseDir)
		removeWorktree(cfg.repoRoot, targetDir)
	}
}
