import { execFile } from "node:child_process"
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import type { ChangeSet } from "../../agent-patch/index.js"
import { truncateUtf8 } from "./bytes.js"
import type { ValidationCheck, ValidationCheckKind } from "./validation.js"

const execFileAsync = promisify(execFile)

/** Directories reused by reference (never copied) because a check may need them but they can be large. */
const LINKED_DIRECTORY_NAMES = ["node_modules", ".git"] as const
const EXCLUDED_DIRECTORY_NAMES = new Set<string>(LINKED_DIRECTORY_NAMES)

const MAX_OUTPUT_BYTES = 32 * 1024
const MAX_EXEC_BUFFER_BYTES = 8 * 1024 * 1024

export interface CandidateCheckOutcome {
	id: string
	kind: ValidationCheckKind
	ok: boolean
	exitCode: number | null
	timedOut: boolean
	durationMs: number
	output: string
}

export interface MaterializedCandidateWorkspace {
	root: string
	cleanup(): Promise<void>
}

/** Lists the workspace's own files, tracked or untracked-but-not-ignored, via git. `undefined` outside a git repo. */
async function trackedWorkspaceFiles(root: string): Promise<string[] | undefined> {
	try {
		const { stdout } = await execFileAsync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
			cwd: root,
			maxBuffer: MAX_EXEC_BUFFER_BYTES,
		})
		return stdout.split("\0").filter(Boolean)
	} catch {
		return undefined
	}
}

/** Fallback file listing for a workspace that isn't a git repository: a full walk excluding the linked directories. */
async function walkWorkspaceFiles(root: string, cursor = "."): Promise<string[]> {
	const absolute = join(root, cursor)
	const entries = await readdir(absolute, { withFileTypes: true })
	const files: string[] = []
	for (const entry of entries) {
		if (cursor === "." && EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue
		const relativePath = cursor === "." ? entry.name : `${cursor}/${entry.name}`
		if (entry.isSymbolicLink()) continue
		if (entry.isDirectory()) files.push(...(await walkWorkspaceFiles(root, relativePath)))
		else if (entry.isFile()) files.push(relativePath)
	}
	return files
}

async function copyWorkspaceFile(sourceRoot: string, workspaceRoot: string, relativePath: string): Promise<void> {
	const sourcePath = join(sourceRoot, relativePath)
	let sourceStat: Awaited<ReturnType<typeof lstat>>
	try {
		sourceStat = await lstat(sourcePath)
	} catch {
		return
	}
	if (!sourceStat.isFile()) return
	const destinationPath = join(workspaceRoot, relativePath)
	await mkdir(dirname(destinationPath), { recursive: true })
	const content = await readFile(sourcePath)
	await writeFile(destinationPath, content, { mode: sourceStat.mode & 0o777 })
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path)
		return true
	} catch {
		return false
	}
}

/**
 * Copies the workspace's own files (excluding `node_modules` and `.git`, which are symlinked instead)
 * into a fresh temporary directory, then overwrites it with the candidate's operations so the
 * resulting tree is exactly what the staged patch would produce. The real workspace is never opened
 * for writing: every file that the candidate touches is written fresh in the copy, never linked, so a
 * check that writes back to a file it just ran against cannot reach the original.
 */
export async function materializeCandidateWorkspace(
	sourceRoot: string,
	changeSet: ChangeSet,
): Promise<MaterializedCandidateWorkspace> {
	const workspaceRoot = await mkdtemp(join(tmpdir(), "kimchi-council-check-"))
	const cleanup = () => rm(workspaceRoot, { recursive: true, force: true })
	try {
		const owned = new Set<string>()
		for (const operation of changeSet.operations) {
			owned.add(operation.path)
			if (operation.kind === "rename") owned.add(operation.fromPath)
		}
		const files = (await trackedWorkspaceFiles(sourceRoot)) ?? (await walkWorkspaceFiles(sourceRoot))
		for (const relativePath of files) {
			if (owned.has(relativePath)) continue
			if (relativePath.split("/").some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment))) continue
			await copyWorkspaceFile(sourceRoot, workspaceRoot, relativePath)
		}
		for (const operation of changeSet.operations) {
			if (operation.kind === "delete") continue
			const destination = join(workspaceRoot, operation.path)
			await mkdir(dirname(destination), { recursive: true })
			await writeFile(destination, operation.content, { mode: operation.mode ?? 0o644 })
		}
		for (const name of LINKED_DIRECTORY_NAMES) {
			const source = join(sourceRoot, name)
			if (!(await pathExists(source))) continue
			await symlink(source, join(workspaceRoot, name), "dir")
		}
		return { root: workspaceRoot, cleanup }
	} catch (error) {
		await cleanup()
		throw error
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError"
}

/**
 * Materializes the candidate into an isolated temporary workspace and runs one catalog check there.
 * The temporary workspace is always removed before this returns or throws, including on timeout and
 * abort. The real workspace at `sourceRoot` is only ever read, never written.
 */
export async function runCandidateCheck(
	sourceRoot: string,
	changeSet: ChangeSet,
	check: ValidationCheck,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<CandidateCheckOutcome> {
	const workspace = await materializeCandidateWorkspace(sourceRoot, changeSet)
	const startedAt = Date.now()
	try {
		const cwd = resolve(workspace.root, check.cwd)
		let stdout = ""
		let stderr = ""
		let exitCode: number | null = 0
		let timedOut = false
		try {
			const result = await execFileAsync(check.executable, check.args, {
				cwd,
				timeout: Math.max(1, timeoutMs),
				killSignal: "SIGKILL",
				maxBuffer: MAX_EXEC_BUFFER_BYTES,
				signal,
				windowsHide: true,
			})
			stdout = result.stdout
			stderr = result.stderr
		} catch (error) {
			if (isAbortError(error)) throw error
			const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean }
			stdout = failure.stdout ?? ""
			stderr = failure.stderr ?? ""
			timedOut = failure.killed === true
			exitCode = typeof failure.code === "number" ? failure.code : null
		}
		return {
			id: check.id,
			kind: check.kind,
			ok: exitCode === 0 && !timedOut,
			exitCode,
			timedOut,
			durationMs: Date.now() - startedAt,
			output: truncateUtf8([stdout, stderr].filter(Boolean).join("\n"), MAX_OUTPUT_BYTES),
		}
	} finally {
		await workspace.cleanup()
	}
}
