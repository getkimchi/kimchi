import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { readConfigSetting } from "../../config/settings.js"

const execFileAsync = promisify(execFile)

export type ValidationCheckKind = "test" | "typecheck" | "lint" | "build"
export type ValidationMutationPolicy = "read-only" | "expected-output-only"

export interface ValidationCheck {
	id: string
	kind: ValidationCheckKind
	cwd: string
	executable: string
	args: string[]
	timeoutMs: number
	mutationPolicy: ValidationMutationPolicy
	expectedOutputs: string[]
}

export interface ValidationSelection {
	checkIds: string[]
}

export interface PatchFileState {
	path: string
	exists: boolean
	sha256?: string
	mode?: number
	content?: Buffer
}

const VALIDATION_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/
const MAX_CHECKS = 20
const KNOWN_RUNNERS: Record<Exclude<ValidationCheckKind, "build">, Set<string>> = {
	test: new Set(["vitest", "jest", "pytest", "node", "go", "cargo"]),
	typecheck: new Set(["tsc", "mypy", "pyright"]),
	lint: new Set(["biome", "eslint", "ruff"]),
}
const KNOWN_EXECUTABLES = new Set([
	"pnpm",
	"npm",
	"npx",
	"yarn",
	"bun",
	"vitest",
	"jest",
	"pytest",
	"node",
	"go",
	"cargo",
	"tsc",
	"mypy",
	"pyright",
	"biome",
	"eslint",
	"ruff",
])
const MUTATING_FLAGS = [
	"--coverage",
	"--emit",
	"--fix",
	"--generate",
	"--output",
	"--snapshot",
	"--update",
	"--watch",
	"--write",
] as const

function plainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizedRelativePath(workspace: string, value: string): string | undefined {
	const absolute = resolve(workspace, value)
	const rel = relative(workspace, absolute)
	if (rel === "" || rel === ".") return "."
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
	return rel.split(sep).join("/")
}

function safeArgs(args: string[]): boolean {
	if (args.length > 64 || args.some((arg) => arg.length > 1_024 || /[\r\n\0]/.test(arg))) return false
	return !args.some((arg) => {
		const lower = arg.toLowerCase()
		return lower === "-u" || MUTATING_FLAGS.some((flag) => lower === flag || lower.startsWith(`${flag}=`))
	})
}

function safeExecutable(executable: string): boolean {
	return KNOWN_EXECUTABLES.has(executable) && !executable.includes("/") && !executable.includes("\\")
}

function normalizeCheck(workspace: string, value: unknown): ValidationCheck | undefined {
	if (!plainObject(value)) return undefined
	const { id, kind, cwd = ".", executable, args, timeoutMs, mutationPolicy, expectedOutputs = [] } = value
	if (
		typeof id !== "string" ||
		!VALIDATION_ID.test(id) ||
		!["test", "typecheck", "lint", "build"].includes(String(kind)) ||
		typeof cwd !== "string" ||
		typeof executable !== "string" ||
		!Array.isArray(args) ||
		!args.every((arg) => typeof arg === "string") ||
		typeof timeoutMs !== "number" ||
		!Number.isInteger(timeoutMs) ||
		!["read-only", "expected-output-only"].includes(String(mutationPolicy)) ||
		!Array.isArray(expectedOutputs) ||
		!expectedOutputs.every((path) => typeof path === "string")
	) {
		return undefined
	}
	const normalizedCwd = normalizedRelativePath(workspace, cwd)
	if (!normalizedCwd || !safeExecutable(executable) || !safeArgs(args)) return undefined
	if (["pnpm", "npm", "yarn", "bun"].includes(executable) && args[0] !== "exec" && args[0] !== "x") return undefined
	if (executable === "npx" && !args.includes("--no-install")) return undefined
	const normalizedOutputs = expectedOutputs
		.map((path) => normalizedRelativePath(workspace, path))
		.filter((path): path is string => Boolean(path && path !== "."))
	if (
		normalizedOutputs.length !== expectedOutputs.length ||
		(mutationPolicy === "read-only" && normalizedOutputs.length > 0) ||
		(mutationPolicy === "expected-output-only" && normalizedOutputs.length === 0)
	) {
		return undefined
	}
	return {
		id,
		kind: kind as ValidationCheckKind,
		cwd: normalizedCwd,
		executable,
		args: [...args],
		timeoutMs: Math.min(120_000, Math.max(1_000, timeoutMs)),
		mutationPolicy: mutationPolicy as ValidationMutationPolicy,
		expectedOutputs: [...new Set(normalizedOutputs)],
	}
}

function tokenizeSimpleCommand(command: string): string[] | undefined {
	if (!command.trim() || /[\r\n;&|`$<>]/.test(command)) return undefined
	const matches = command.match(/(?:[^\s"'\\]+|"[^"]*"|'[^']*')+/g)
	if (!matches) return undefined
	const tokens = matches.map((token) => {
		if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
			return token.slice(1, -1)
		}
		return token
	})
	return tokens.every((token) => token && !/[\r\n\0]/.test(token)) ? tokens : undefined
}

function packageManagerCommand(
	workspace: string,
	runner: string,
	args: string[],
): Pick<ValidationCheck, "executable" | "args"> {
	if (existsSync(resolve(workspace, "pnpm-lock.yaml"))) return { executable: "pnpm", args: ["exec", runner, ...args] }
	if (existsSync(resolve(workspace, "yarn.lock"))) return { executable: "yarn", args: ["exec", runner, ...args] }
	if (existsSync(resolve(workspace, "bun.lock")) || existsSync(resolve(workspace, "bun.lockb"))) {
		return { executable: "bun", args: ["x", runner, ...args] }
	}
	return { executable: "npx", args: ["--no-install", runner, ...args] }
}

function packageChecks(workspace: string): ValidationCheck[] {
	const packagePath = resolve(workspace, "package.json")
	if (!existsSync(packagePath)) return []
	let parsed: unknown
	try {
		parsed = JSON.parse(readFileSync(packagePath, "utf8"))
	} catch {
		return []
	}
	if (!plainObject(parsed) || !plainObject(parsed.scripts)) return []
	const checks: ValidationCheck[] = []
	for (const kind of ["test", "typecheck", "lint"] as const) {
		const script = parsed.scripts[kind]
		if (typeof script !== "string") continue
		const tokens = tokenizeSimpleCommand(script)
		if (!tokens?.length) continue
		while (
			tokens.length >= 2 &&
			["pnpm", "npm", "yarn"].includes(tokens[0] ?? "") &&
			["exec", "x"].includes(tokens[1] ?? "")
		) {
			tokens.splice(0, 2)
		}
		if (tokens[0] === "npx") {
			tokens.splice(0, tokens[1] === "--no-install" ? 2 : 1)
		}
		const runner = tokens.shift()
		if (!runner || !KNOWN_RUNNERS[kind].has(runner) || !safeArgs(tokens)) continue
		if (runner === "tsc" && !tokens.some((arg) => arg.toLowerCase() === "--noemit")) continue
		const command =
			runner === "node" || runner === "go" || runner === "cargo"
				? { executable: runner, args: tokens }
				: packageManagerCommand(workspace, runner, tokens)
		checks.push({
			id: `package.${kind}`,
			kind,
			cwd: ".",
			...command,
			timeoutMs: kind === "test" ? 90_000 : 60_000,
			mutationPolicy: "read-only",
			expectedOutputs: [],
		})
	}
	return checks
}

function repositoryChecks(workspace: string): ValidationCheck[] {
	if (existsSync(resolve(workspace, "pyproject.toml")) || existsSync(resolve(workspace, "pytest.ini"))) {
		return [
			{
				id: "repo.pytest",
				kind: "test",
				cwd: ".",
				executable: "pytest",
				args: ["-q", "-p", "no:cacheprovider"],
				timeoutMs: 90_000,
				mutationPolicy: "read-only",
				expectedOutputs: [],
			},
		]
	}
	if (existsSync(resolve(workspace, "go.mod"))) {
		return [
			{
				id: "repo.go-test",
				kind: "test",
				cwd: ".",
				executable: "go",
				args: ["test", "./..."],
				timeoutMs: 90_000,
				mutationPolicy: "read-only",
				expectedOutputs: [],
			},
		]
	}
	if (existsSync(resolve(workspace, "Cargo.toml"))) {
		return [
			{
				id: "repo.cargo-test",
				kind: "test",
				cwd: ".",
				executable: "cargo",
				args: ["test", "--quiet"],
				timeoutMs: 120_000,
				mutationPolicy: "expected-output-only",
				expectedOutputs: ["target"],
			},
		]
	}
	return []
}

function explicitHarnessChecks(): unknown[] {
	const value = readConfigSetting("councilValidationChecks", Array.isArray)
	return value ?? []
}

export function buildValidationCatalog(
	workspace: string,
	explicit: unknown[] = explicitHarnessChecks(),
): ValidationCheck[] {
	const checks = new Map<string, ValidationCheck>()
	for (const check of [...packageChecks(workspace), ...repositoryChecks(workspace)]) checks.set(check.id, check)
	for (const value of explicit.slice(0, MAX_CHECKS)) {
		const check = normalizeCheck(workspace, value)
		if (check) checks.set(check.id, check)
	}
	return [...checks.values()].slice(0, MAX_CHECKS)
}

async function snapshotPatchFile(workspace: string, path: string): Promise<PatchFileState> {
	const absolute = resolve(workspace, path)
	try {
		const stat = await lstat(absolute)
		if (!stat.isFile() || stat.isSymbolicLink()) return { path, exists: true }
		const content = await readFile(absolute)
		return {
			path,
			exists: true,
			sha256: createHash("sha256").update(content).digest("hex"),
			mode: stat.mode & 0o777,
			content,
		}
	} catch {
		return { path, exists: false }
	}
}

/**
 * Snapshots only the files a candidate patch actually touches (create/update/delete/rename
 * targets), byte content included so `restorePatchFiles` can undo an unexpected mutation. This
 * keeps post-apply validation bounded to the candidate's touched-file set, normally a handful of
 * paths. Validation commands are catalog-allowlisted and non-mutating by construction
 * (validationCommand/buildValidationCatalog).
 */
export async function snapshotPatchFiles(workspace: string, paths: readonly string[]): Promise<PatchFileState[]> {
	return Promise.all([...new Set(paths)].sort().map((path) => snapshotPatchFile(workspace, path)))
}

export function patchFilesChanged(before: readonly PatchFileState[], after: readonly PatchFileState[]): boolean {
	if (before.length !== after.length) return true
	return before.some((entry, index) => {
		const next = after[index]
		return (
			!next ||
			entry.path !== next.path ||
			entry.exists !== next.exists ||
			entry.sha256 !== next.sha256 ||
			entry.mode !== next.mode
		)
	})
}

/** Stable digest over a touched-file snapshot, for the post-apply-check audit record. */
export function hashPatchFiles(states: readonly PatchFileState[]): string {
	const hash = createHash("sha256")
	for (const entry of states) {
		hash.update(entry.path)
		hash.update("\0")
		hash.update(String(entry.exists))
		hash.update("\0")
		hash.update(entry.sha256 ?? "")
		hash.update("\0")
		hash.update(String(entry.mode ?? ""))
		hash.update("\0")
	}
	return hash.digest("hex")
}

export async function restorePatchFiles(workspace: string, snapshot: readonly PatchFileState[]): Promise<void> {
	for (const entry of snapshot) {
		const absolute = resolve(workspace, entry.path)
		if (!entry.exists) {
			await rm(absolute, { force: true })
			continue
		}
		await mkdir(dirname(absolute), { recursive: true })
		await writeFile(absolute, entry.content ?? Buffer.alloc(0), { mode: entry.mode ?? 0o644 })
		await chmod(absolute, entry.mode ?? 0o644)
	}
}

function isExpectedOutput(path: string, expectedOutputs: readonly string[]): boolean {
	return expectedOutputs.some((expected) => path === expected || path.startsWith(`${expected}/`))
}

/** Unquotes a git-porcelain path, which is C-style quoted only when it contains special characters. */
function unquoteGitStatusPath(path: string): string {
	if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path
	try {
		return JSON.parse(path) as string
	} catch {
		return path.slice(1, -1)
	}
}

/** Extracts the path(s) referenced by one `git status --porcelain` line, including renames. */
function gitStatusLinePaths(line: string): string[] {
	const rest = line.slice(3)
	const arrowIndex = rest.indexOf(" -> ")
	if (arrowIndex === -1) return [unquoteGitStatusPath(rest)]
	return [unquoteGitStatusPath(rest.slice(0, arrowIndex)), unquoteGitStatusPath(rest.slice(arrowIndex + 4))]
}

/**
 * Drops porcelain lines whose path(s) fall entirely under one of the check's typed expected
 * outputs (e.g. `target` for a cargo test run). A rename line is only dropped when both paths are
 * expected outputs.
 */
export function filterExpectedOutputs(porcelain: string, expectedOutputs: readonly string[]): string {
	if (!porcelain || expectedOutputs.length === 0) return porcelain
	return porcelain
		.split("\n")
		.filter((line) => {
			if (!line) return false
			const paths = gitStatusLinePaths(line)
			return !paths.every((path) => isExpectedOutput(path, expectedOutputs))
		})
		.join("\n")
}

/**
 * Cheap canary for drift outside the patch's own touched files: the porcelain status line count
 * and content should be identical immediately before and after a non-mutating validation command.
 * Returns `""` when the workspace is not a git repository (or git is unavailable) — the
 * touched-file hash check above is authoritative either way; this is a best-effort second signal.
 */
export async function gitStatusPorcelain(workspace: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
			cwd: workspace,
			maxBuffer: 4 * 1024 * 1024,
		})
		return stdout
	} catch {
		return ""
	}
}

function shellWord(value: string): string {
	return /^[a-zA-Z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}

export function validationCommand(check: ValidationCheck): string {
	const command = [check.executable, ...check.args].map(shellWord).join(" ")
	return check.cwd === "." ? command : `cd -- ${shellWord(check.cwd)} && ${command}`
}

export function validationCatalogForPrompt(catalog: readonly ValidationCheck[]): Array<{
	id: string
	kind: ValidationCheckKind
	cwd: string
	description: string
	timeout_ms: number
	mutation_policy: ValidationMutationPolicy
}> {
	return catalog.map((check) => ({
		id: check.id,
		kind: check.kind,
		cwd: check.cwd,
		description: `${check.executable} ${check.kind} check`,
		timeout_ms: check.timeoutMs,
		mutation_policy: check.mutationPolicy,
	}))
}
