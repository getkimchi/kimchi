/**
 * Remote completion-diff collection — the review phase of a PR-intent run.
 *
 * Everything here runs against the SANDBOX repo over SSH via runSandboxGit —
 * the review phase performs zero local git operations. collectCompletionDiff
 * gathers the stat/name-only/status data the completion dropdown needs;
 * streamRemotePatch streams the full unified patch chunk-by-chunk for the
 * live viewer, appending each chunk to a transcript-side patch file on the
 * way through.
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { parsePorcelainPaths, runSandboxGit, type SandboxGitConnection } from "./sandbox-git.js"

export interface CompletionDiffStat {
	/** Files changed between the PR baseline and HEAD (from --name-only). */
	files: number
	additions: number
	deletions: number
	/** Paths changed between the PR baseline and HEAD. */
	filesList: string[]
	/** Uncommitted paths the agent left behind — not included in the diff. */
	leftoverFiles: string[]
	/** The user's pre-existing dirty files the run also touched — surprise edits. */
	touchedBaselineFiles: string[]
}

/** Parse the trailing summary of `git diff --stat` — the per-file columns are
 *  ignored; only the "N files changed, M insertions(+), K deletions(-)" line
 *  feeds the counts. */
export function parseDiffStat(stdout: string): { files: number; additions: number; deletions: number } {
	const match = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(stdout)
	if (!match) return { files: 0, additions: 0, deletions: 0 }
	return { files: Number(match[1]), additions: Number(match[2] ?? 0), deletions: Number(match[3] ?? 0) }
}

export interface CollectDiffOptions {
	connection: SandboxGitConnection
	/** Baseline captured at provisioning (pre-prompt HEAD). */
	baseSha: string
	/** The user's pre-existing dirty files from the baseline capture. */
	baselineDirtyFiles?: string[]
	signal?: AbortSignal
}

/** Collect everything the PR review dropdown needs in four SSH git calls.
 *  Returns undefined when HEAD == baseSha (no committed work at all) — the
 *  caller degrades to the plain completion menu.
 *  Throws SandboxGitError on transport/git failure — the caller degrades. */
export async function collectCompletionDiff(opts: CollectDiffOptions): Promise<CompletionDiffStat | undefined> {
	const { connection, signal } = opts
	const head = await runSandboxGit({ connection, args: ["rev-parse", "HEAD"], signal })
	if (head.stdout.trim() === opts.baseSha) return undefined

	const range = `${opts.baseSha}...HEAD`
	const [stat, nameOnly, status] = await Promise.all([
		runSandboxGit({ connection, args: ["diff", "--stat", range], signal }),
		runSandboxGit({ connection, args: ["diff", "--name-only", range], signal }),
		runSandboxGit({ connection, args: ["status", "--porcelain"], signal }),
	])

	const { additions, deletions } = parseDiffStat(stat.stdout)
	const filesList = nameOnly.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
	const baseline = new Set(opts.baselineDirtyFiles ?? [])
	const currentDirty = parsePorcelainPaths(status.stdout)
	const touchedBaselineFiles = currentDirty.filter((path) => baseline.has(path))
	const leftoverFiles = currentDirty.filter((path) => !baseline.has(path))

	return { files: filesList.length, additions, deletions, filesList, leftoverFiles, touchedBaselineFiles }
}

export interface RemotePatchStream {
	/** Abort the stream (viewer closed early). The promise resolves with what arrived. */
	cancel(): void
	promise: Promise<{ bytesAppended: number; cancelled: boolean }>
}

export interface StreamPatchOptions {
	connection: SandboxGitConnection
	baseSha: string
	/** Transcript-side patch file; each chunk is appended as it arrives. */
	patchPath?: string
	signal?: AbortSignal
	onChunk: (version: 1, chunk: string) => void
}

/** Stream `git diff --binary <baseSha>...HEAD` chunk-by-chunk: every chunk is
 *  appended to the patch file (when configured) and pushed to onChunk.
 *  Cancelling (or an aborted outer signal) resolves the promise instead of
 *  rejecting — a closed viewer is not an error. Real git/SSH failures reject. */
export function streamRemotePatch(opts: StreamPatchOptions): RemotePatchStream {
	const controller = new AbortController()
	opts.signal?.addEventListener("abort", () => controller.abort(), { once: true })
	let bytesAppended = 0
	if (opts.patchPath) mkdirSync(dirname(opts.patchPath), { recursive: true })

	const promise = runSandboxGit({
		connection: opts.connection,
		args: ["diff", "--binary", `${opts.baseSha}...HEAD`],
		signal: controller.signal,
		onStdoutChunk: (chunk) => {
			bytesAppended += Buffer.byteLength(chunk, "utf8")
			if (opts.patchPath) appendFileSync(opts.patchPath, chunk)
			opts.onChunk(1, chunk)
		},
	}).then(
		() => ({ bytesAppended, cancelled: false }),
		(err: unknown) => {
			if (controller.signal.aborted) return { bytesAppended, cancelled: true }
			throw err
		},
	)
	return { cancel: () => controller.abort(), promise }
}
