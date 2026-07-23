import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { chmod, lstat, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { readConfigSetting } from "../../config/settings.js"

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

interface SnapshotEntry {
	kind: "directory" | "file" | "symlink"
	mode: number
	content?: Buffer
	target?: string
}

export interface WorkspaceSnapshot {
	sha256: string
	entries: Map<string, SnapshotEntry>
	expectedOutputs: string[]
}

const VALIDATION_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/
const MAX_CHECKS = 20
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024
const MAX_SNAPSHOT_ENTRIES = 50_000
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"])
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

function isExpectedOutput(path: string, expectedOutputs: readonly string[]): boolean {
	return expectedOutputs.some((expected) => path === expected || path.startsWith(`${expected}/`))
}

function hashEntry(hash: ReturnType<typeof createHash>, path: string, entry: SnapshotEntry): void {
	hash.update(path)
	hash.update("\0")
	hash.update(entry.kind)
	hash.update("\0")
	hash.update(String(entry.mode))
	hash.update("\0")
	if (entry.content) hash.update(entry.content)
	if (entry.target) hash.update(entry.target)
	hash.update("\0")
}

export async function captureWorkspaceSnapshot(
	workspace: string,
	expectedOutputs: readonly string[] = [],
): Promise<WorkspaceSnapshot> {
	const entries = new Map<string, SnapshotEntry>()
	const hash = createHash("sha256")
	let totalBytes = 0
	let entryCount = 0
	const walk = async (relativePath: string): Promise<void> => {
		const absolutePath = relativePath ? resolve(workspace, relativePath) : workspace
		const names = await readdir(absolutePath, { withFileTypes: true })
		for (const name of names.sort((left, right) => left.name.localeCompare(right.name))) {
			const path = relativePath ? `${relativePath}/${name.name}` : name.name
			if (SKIPPED_DIRECTORIES.has(name.name) || isExpectedOutput(path, expectedOutputs)) continue
			if (++entryCount > MAX_SNAPSHOT_ENTRIES) {
				throw new Error("Council validation workspace snapshot exceeds the entry limit")
			}
			const absolute = resolve(workspace, path)
			const stat = await lstat(absolute)
			if (stat.isDirectory()) {
				const entry: SnapshotEntry = { kind: "directory", mode: stat.mode & 0o777 }
				entries.set(path, entry)
				hashEntry(hash, path, entry)
				await walk(path)
				continue
			}
			if (stat.isSymbolicLink()) {
				const entry: SnapshotEntry = { kind: "symlink", mode: stat.mode & 0o777, target: await readlink(absolute) }
				entries.set(path, entry)
				hashEntry(hash, path, entry)
				continue
			}
			if (!stat.isFile()) throw new Error(`Council validation cannot snapshot special file: ${path}`)
			const content = await readFile(absolute)
			totalBytes += content.byteLength
			if (totalBytes > MAX_SNAPSHOT_BYTES) {
				throw new Error("Council validation workspace snapshot exceeds the byte limit")
			}
			const entry: SnapshotEntry = { kind: "file", mode: stat.mode & 0o777, content }
			entries.set(path, entry)
			hashEntry(hash, path, entry)
		}
	}
	await walk("")
	return { sha256: hash.digest("hex"), entries, expectedOutputs: [...expectedOutputs] }
}

async function currentWorkspacePaths(workspace: string, expectedOutputs: readonly string[]): Promise<string[]> {
	const paths: string[] = []
	const walk = async (relativePath: string): Promise<void> => {
		const absolutePath = relativePath ? resolve(workspace, relativePath) : workspace
		for (const name of await readdir(absolutePath, { withFileTypes: true })) {
			const path = relativePath ? `${relativePath}/${name.name}` : name.name
			if (SKIPPED_DIRECTORIES.has(name.name) || isExpectedOutput(path, expectedOutputs)) continue
			if (paths.length >= MAX_SNAPSHOT_ENTRIES * 2) {
				throw new Error("Council validation rollback exceeds the entry limit")
			}
			paths.push(path)
			if (name.isDirectory()) await walk(path)
		}
	}
	await walk("")
	return paths
}

export async function restoreWorkspaceSnapshot(workspace: string, snapshot: WorkspaceSnapshot): Promise<void> {
	const currentPaths = await currentWorkspacePaths(workspace, snapshot.expectedOutputs)
	for (const path of currentPaths.sort((left, right) => right.length - left.length)) {
		if (!snapshot.entries.has(path)) await rm(resolve(workspace, path), { force: true, recursive: true })
	}
	const ordered = [...snapshot.entries.entries()].sort(([left], [right]) => left.length - right.length)
	for (const [path, entry] of ordered) {
		const absolute = resolve(workspace, path)
		if (entry.kind === "directory") {
			await mkdir(absolute, { recursive: true, mode: entry.mode })
			await chmod(absolute, entry.mode)
			continue
		}
		await mkdir(dirname(absolute), { recursive: true })
		let currentKind: SnapshotEntry["kind"] | undefined
		try {
			const stat = await lstat(absolute)
			currentKind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file"
		} catch {
			currentKind = undefined
		}
		if (currentKind && currentKind !== entry.kind) await rm(absolute, { force: true, recursive: true })
		if (entry.kind === "symlink") {
			if (currentKind === "symlink") await rm(absolute, { force: true })
			await symlink(entry.target ?? "", absolute)
		} else {
			await writeFile(absolute, entry.content ?? Buffer.alloc(0), { mode: entry.mode })
			await chmod(absolute, entry.mode)
		}
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
