import { AsyncLocalStorage } from "node:async_hooks"
import { execFile } from "node:child_process"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ReviewTargetError } from "./types.js"

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024
const GIT_TIMEOUT_MS = 120_000
const resolutionFetchAuthorization = new AsyncLocalStorage<boolean>()

/** Keep network authorization local to one resolution, including its concurrent object reads. */
export function withReviewTargetFetchAuthorization<T>(authorized: boolean, operation: () => T): T {
	return resolutionFetchAuthorization.run(authorized, operation)
}

function lazyFetchAllowed(explicit: boolean | undefined): boolean {
	return explicit ?? resolutionFetchAuthorization.getStore() ?? false
}

type GitProcessError = Error & { code?: number | string }

interface RawGitResult {
	stdout: Buffer
	stderr: Buffer
	failure?: GitProcessError
}

export interface GitRunOptions {
	input?: Buffer | string
	env?: Record<string, string>
	signal?: AbortSignal
	allowFailure?: boolean
	/** Per-command override; resolution-scoped authorization normally supplies this. */
	lazyFetch?: boolean
}

export interface GitResult {
	stdout: Buffer
	exitCode: number
	stderr: string
	failure?: GitProcessError
}

export class GitCommandError extends Error {
	constructor(
		readonly args: readonly string[],
		readonly exitCode: number | undefined,
		readonly stderr: string,
		options?: { cause?: unknown },
	) {
		super(`git ${args.join(" ")} failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`, options)
	}
}

function missingObjectOutput(value: string): boolean {
	return /missing (?:blob|tree|commit|object)|unable to read (?:tree )?[0-9a-f]{7,64}|could not fetch .+ from promisor remote|object not found|no such object/i.test(
		value,
	)
}

function exitCode(failure: GitProcessError | undefined): number {
	return typeof failure?.code === "number" ? failure.code : failure ? 1 : 0
}

/** Turn a failed result back into the error that permissive callers must not mistake for absence. */
export function gitResultError(args: readonly string[], result: GitResult, lazyFetch?: boolean): Error {
	const detail = result.stderr.trim() || result.failure?.message || "unknown Git failure"
	if (!lazyFetchAllowed(lazyFetch) && missingObjectOutput(detail)) {
		return new ReviewTargetError(
			"missing_object",
			`${detail}. An object is unavailable locally and lazy fetching is disabled. Make the promisor reachable and retry with --fetch.`,
		)
	}
	return new GitCommandError(args, exitCode(result.failure), detail, { cause: result.failure })
}

function finished(raw: RawGitResult): GitResult {
	return {
		stdout: raw.stdout,
		stderr: raw.stderr.toString("utf8"),
		exitCode: exitCode(raw.failure),
		...(raw.failure ? { failure: raw.failure } : {}),
	}
}

function runRaw(
	cwd: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv,
	hooksDir: string,
	extraConfig: readonly string[],
	options: GitRunOptions,
): Promise<RawGitResult> {
	return new Promise((resolve) => {
		const child = execFile(
			"git",
			["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${hooksDir}`, ...extraConfig, "-C", cwd, ...args],
			{
				encoding: "buffer",
				timeout: GIT_TIMEOUT_MS,
				maxBuffer: MAX_GIT_OUTPUT_BYTES,
				env,
				signal: options.signal,
			},
			(error, stdout, stderr) => {
				resolve({ stdout, stderr, ...(error ? { failure: error as GitProcessError } : {}) })
			},
		)
		child.stdin?.on("error", () => {})
		child.stdin?.end(options.input)
	})
}

function filterOverrides(output: Buffer): string[] {
	const drivers = new Set<string>()
	for (const key of output.toString("utf8").split("\0")) {
		if (!key.startsWith("filter.")) continue
		const suffix = key.lastIndexOf(".")
		if (suffix <= "filter.".length) continue
		const capability = key.slice(suffix + 1)
		if (capability === "clean" || capability === "smudge" || capability === "process") {
			drivers.add(key.slice("filter.".length, suffix))
		}
	}
	return [...drivers]
		.sort()
		.flatMap((driver) => [
			"-c",
			`filter.${driver}.clean=`,
			"-c",
			`filter.${driver}.smudge=`,
			"-c",
			`filter.${driver}.process=`,
		])
}

/** Run Git with process-owned empty hooks, forced conversion failures, and no implicit object fetching. */
export async function gitBytes(cwd: string, args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		GIT_OPTIONAL_LOCKS: "0",
		// No call relies on glob expansion, including stdin pathspec files.
		GIT_LITERAL_PATHSPECS: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_PAGER: "cat",
		LC_ALL: "C",
	}
	for (const key of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_COMMON_DIR",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	])
		delete env[key]
	if (!lazyFetchAllowed(options.lazyFetch)) env.GIT_NO_LAZY_FETCH = "1"
	else env.GIT_NO_LAZY_FETCH = undefined
	Object.assign(env, options.env)

	const hooksDir = await mkdtemp(join(tmpdir(), "kimchi-review-no-hooks-"))
	try {
		// Config inspection cannot invoke hooks or content conversion. Discover driver
		// names so actual commands override every configured executable with an empty,
		// failing command, even if a call site forgets preflight.
		const filters = await runRaw(
			cwd,
			["config", "--name-only", "--null", "--get-regexp", "^filter\\."],
			env,
			hooksDir,
			[],
			{ ...options, input: undefined, allowFailure: true },
		)
		if (filters.failure && filters.failure.code !== 1) {
			const result = finished(filters)
			if (!options.allowFailure) throw gitResultError(args, result, options.lazyFetch)
			return result
		}
		const raw = await runRaw(cwd, args, env, hooksDir, filterOverrides(filters.stdout), options)
		const result = finished(raw)
		if (raw.failure && !options.allowFailure) throw gitResultError(args, result, options.lazyFetch)
		return result
	} finally {
		await rm(hooksDir, { recursive: true, force: true })
	}
}

export async function gitText(cwd: string, args: readonly string[], options: GitRunOptions = {}): Promise<string> {
	return (await gitBytes(cwd, args, options)).stdout.toString("utf8").trimEnd()
}

export async function resolveCommit(cwd: string, ref: string, signal?: AbortSignal): Promise<string> {
	try {
		const value = await gitText(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { signal })
		if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error("unexpected object ID")
		return value
	} catch (error) {
		if (error instanceof ReviewTargetError && error.code === "missing_object") throw error
		throw new ReviewTargetError("unknown_revision", `Cannot resolve "${ref}" to a commit: ${errorMessage(error)}`)
	}
}

export async function optionalCommit(cwd: string, ref: string, signal?: AbortSignal): Promise<string | undefined> {
	const args = ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`] as const
	const result = await gitBytes(cwd, args, { signal, allowFailure: true })
	if (result.exitCode !== 0) {
		if ((result.failure && typeof result.failure.code !== "number") || missingObjectOutput(result.stderr))
			throw gitResultError(args, result)
		return undefined
	}
	const value = result.stdout.toString("utf8").trim()
	return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) ? value : undefined
}

export async function repositoryRoot(cwd: string, signal?: AbortSignal): Promise<string> {
	try {
		const root = await gitText(cwd, ["rev-parse", "--show-toplevel"], { signal })
		if (!root) throw new Error("no worktree root")
		return await realpath(root)
	} catch (error) {
		if (error instanceof ReviewTargetError && error.code === "missing_object") throw error
		throw new ReviewTargetError("not_a_worktree", `${cwd} is not inside a Git working tree: ${errorMessage(error)}`)
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
