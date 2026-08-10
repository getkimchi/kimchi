import { execFile } from "node:child_process"
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path"
import { promisify } from "node:util"
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent"
import { z } from "zod"
import type { ChangeSet, ChangeTransaction } from "../../agent-patch/index.js"
import { truncateUtf8 } from "./physical-invoker.js"
import { DEFAULT_COUNCIL_TRANSACTION_LIMITS } from "./transaction.js"
import type { ValidationCheck, ValidationCheckKind } from "./validation.js"

const execFileAsync = promisify(execFile)

export const CANDIDATE_PATCH_SCHEMA =
	'{"type":"object","additionalProperties":false,"required":["operations"],"properties":{"operations":{"type":"array","items":{"oneOf":[{"type":"object","additionalProperties":false,"required":["op","path","content"],"properties":{"op":{"const":"create"},"path":{"type":"string"},"content":{"type":"string","description":"Complete new file text"}}},{"type":"object","additionalProperties":false,"required":["op","path","content"],"properties":{"op":{"const":"update"},"path":{"type":"string"},"content":{"type":"string","description":"Complete new file text"}}},{"type":"object","additionalProperties":false,"required":["op","path"],"properties":{"op":{"const":"delete"},"path":{"type":"string"}}},{"type":"object","additionalProperties":false,"required":["op","path","new_path"],"properties":{"op":{"const":"rename"},"path":{"type":"string"},"new_path":{"type":"string"}}}]}}}}'

function isNormalizedWorkspacePath(value: string): boolean {
	if (!value.trim() || value.includes("\0") || value.includes("\\")) return false
	if (isAbsolute(value) || win32.isAbsolute(value)) return false
	if (value !== posix.normalize(value) || value.normalize("NFC") !== value) return false
	return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
}

const CandidatePathSchema = z
	.string()
	.refine(isNormalizedWorkspacePath, "Path must be a normalized workspace-relative file path")

const CandidatePatchOperationSchema = z.discriminatedUnion("op", [
	z
		.object({
			op: z.literal("create"),
			path: CandidatePathSchema,
			content: z.string(),
		})
		.strict(),
	z
		.object({
			op: z.literal("update"),
			path: CandidatePathSchema,
			content: z.string(),
		})
		.strict(),
	z
		.object({
			op: z.literal("delete"),
			path: CandidatePathSchema,
		})
		.strict(),
	z
		.object({
			op: z.literal("rename"),
			path: CandidatePathSchema,
			new_path: CandidatePathSchema,
		})
		.strict(),
])

export const CandidatePatchSchema = z
	.object({ operations: z.array(CandidatePatchOperationSchema) })
	.strict()
	.superRefine((patch, context) => {
		const paths = new Map<string, { index: number; field: string }>()
		for (const [index, operation] of patch.operations.entries()) {
			const entries =
				operation.op === "rename"
					? [["path", operation.path] as const, ["new_path", operation.new_path] as const]
					: [["path", operation.path] as const]
			for (const [field, path] of entries) {
				if (paths.has(path)) {
					context.addIssue({
						code: "custom",
						path: ["operations", index, field],
						message: `Duplicate or colliding patch path: ${path}`,
					})
				} else {
					paths.set(path, { index, field })
				}
			}
		}
	})

export type CandidatePatch = z.infer<typeof CandidatePatchSchema>
type CandidatePatchOperation = CandidatePatch["operations"][number]

type CandidatePatchFailureCode = "invalid_patch" | "path" | "base_drift" | "limits" | "transaction"

class CandidatePatchStageError extends Error {
	readonly code: CandidatePatchFailureCode

	constructor(code: CandidatePatchFailureCode, message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = "CandidatePatchStageError"
		this.code = code
	}
}

export interface StagePatchSuccess {
	ok: true
	transaction: ChangeTransaction
	changeSet: ChangeSet
}

interface StagePatchFailure {
	ok: false
	code: CandidatePatchFailureCode
	message: string
	error: CandidatePatchStageError
}

type StagePatchResult = StagePatchSuccess | StagePatchFailure

interface RenderPatchDiffOptions {
	maxBytes?: number
}

function failure(code: CandidatePatchFailureCode, message: string, cause?: unknown): StagePatchFailure {
	const error =
		cause instanceof CandidatePatchStageError && cause.code === code
			? cause
			: new CandidatePatchStageError(code, message, cause === undefined ? undefined : { cause })
	return { ok: false, code: error.code, message: error.message, error }
}

function parsePatch(value: unknown): CandidatePatch | StagePatchFailure {
	const parsed = CandidatePatchSchema.safeParse(value)
	if (parsed.success) return parsed.data
	return failure("invalid_patch", z.prettifyError(parsed.error), parsed.error)
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT"
}

async function assertAbsent(transaction: ChangeTransaction, path: string): Promise<void> {
	try {
		await transaction.readBuffer(path)
	} catch (error) {
		if (isMissingFile(error)) return
		throw error
	}
	throw new CandidatePatchStageError("path", `Patch path already exists: ${path}`)
}

async function validatePatchAgainstTransaction(transaction: ChangeTransaction, patch: CandidatePatch): Promise<void> {
	const verification = await transaction.verifyBase()
	if (!verification.ok) {
		throw new CandidatePatchStageError(
			"base_drift",
			`Workspace changed before patch staging: ${verification.conflicts.map(({ path }) => path).join(", ")}`,
		)
	}

	for (const operation of patch.operations) {
		await transaction.validatePath(operation.path)
		if (operation.op === "rename") await transaction.validatePath(operation.new_path)

		if (operation.op === "create") {
			await assertAbsent(transaction, operation.path)
		} else {
			await transaction.readBuffer(operation.path)
			if (operation.op === "rename") await assertAbsent(transaction, operation.new_path)
		}
	}
}

function limitError(changeSet: ChangeSet): CandidatePatchStageError | undefined {
	const changedLines = changeSet.stats.addedLines + changeSet.stats.removedLines
	const limits = DEFAULT_COUNCIL_TRANSACTION_LIMITS
	if (changeSet.stats.files > limits.maxFiles) {
		return new CandidatePatchStageError(
			"limits",
			`Council candidate exceeds the ${limits.maxFiles}-file transaction limit`,
		)
	}
	if (changedLines > limits.maxChangedLines) {
		return new CandidatePatchStageError(
			"limits",
			`Council candidate exceeds the ${limits.maxChangedLines}-line transaction limit`,
		)
	}
	if (changeSet.stats.patchBytes > limits.maxPatchBytes) {
		return new CandidatePatchStageError(
			"limits",
			`Council candidate exceeds the ${limits.maxPatchBytes}-byte transaction limit`,
		)
	}
	return undefined
}

async function stageOperation(transaction: ChangeTransaction, operation: CandidatePatchOperation): Promise<void> {
	if (operation.op === "create" || operation.op === "update") {
		await transaction.stageWrite(operation.path, operation.content)
	} else if (operation.op === "delete") {
		await transaction.stageDelete(operation.path)
	} else {
		await transaction.stageRename(operation.path, operation.new_path)
	}
}

export async function stagePatch(transaction: ChangeTransaction, patch: unknown): Promise<StagePatchResult> {
	const parsed = parsePatch(patch)
	if (!("operations" in parsed)) return parsed

	try {
		await validatePatchAgainstTransaction(transaction, parsed)
		for (const operation of parsed.operations) await stageOperation(transaction, operation)
		const changeSet = transaction.changeSet()
		const bounded = limitError(changeSet)
		if (bounded) {
			await transaction.discard()
			return failure(bounded.code, bounded.message, bounded)
		}
		const verification = await transaction.verifyBase()
		if (!verification.ok) {
			await transaction.discard()
			return failure(
				"base_drift",
				`Workspace changed during patch staging: ${verification.conflicts.map(({ path }) => path).join(", ")}`,
			)
		}
		return { ok: true, transaction, changeSet }
	} catch (error) {
		if (transaction.state === "staging") await transaction.discard()
		if (error instanceof CandidatePatchStageError) return failure(error.code, error.message, error)
		return failure("transaction", error instanceof Error ? error.message : String(error), error)
	}
}

function boundDiff(value: string, maximumBytes: number): string {
	if (maximumBytes <= 0) throw new CandidatePatchStageError("limits", "Diff byte bound must be positive")
	if (Buffer.byteLength(value) <= maximumBytes) return value
	const marker = `\n[diff truncated at ${maximumBytes} bytes]\n`
	const markerBytes = Buffer.byteLength(marker)
	if (markerBytes >= maximumBytes) return truncateUtf8(marker, maximumBytes)
	return `${truncateUtf8(value, maximumBytes - markerBytes)}${marker}`
}

async function readBufferForDisplay(transaction: ChangeTransaction, path: string): Promise<string> {
	try {
		return (await transaction.readBuffer(path)).toString("utf8")
	} catch (error) {
		if (isMissingFile(error)) return ""
		throw error
	}
}

/**
 * Renders a candidate patch as a unified diff for display/comparison only. This is not an
 * apply-time check: base content is read best-effort so a path that does not exist (or a
 * `create` that collides with an existing path) still renders instead of throwing. Every
 * invariant that governs what actually gets written to disk is enforced by `stagePatch`.
 */
export async function renderPatchDiff(
	transaction: ChangeTransaction,
	patch: unknown,
	options: RenderPatchDiffOptions | number = {},
): Promise<string> {
	const parsed = parsePatch(patch)
	if (!("operations" in parsed)) throw parsed.error

	const sections = ["# candidate-patch v1"]
	for (const operation of parsed.operations) {
		if (operation.op === "create") {
			const base = await readBufferForDisplay(transaction, operation.path)
			sections.push(`# create ${operation.path}`, generateUnifiedPatch(operation.path, base, operation.content))
		} else if (operation.op === "update") {
			const base = await readBufferForDisplay(transaction, operation.path)
			sections.push(`# update ${operation.path}`, generateUnifiedPatch(operation.path, base, operation.content))
		} else if (operation.op === "delete") {
			const base = await readBufferForDisplay(transaction, operation.path)
			sections.push(`# delete ${operation.path}`, generateUnifiedPatch(operation.path, base, ""))
		} else {
			const base = await readBufferForDisplay(transaction, operation.path)
			sections.push(
				`# rename ${operation.path} -> ${operation.new_path}`,
				generateUnifiedPatch(operation.path, base, ""),
				generateUnifiedPatch(operation.new_path, "", base),
			)
		}
	}

	const rendered = `${sections.join("\n")}\n`
	const maximumBytes =
		typeof options === "number" ? options : (options.maxBytes ?? DEFAULT_COUNCIL_TRANSACTION_LIMITS.maxPatchBytes)
	return boundDiff(rendered, maximumBytes)
}

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

interface MaterializedCandidateWorkspace {
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
