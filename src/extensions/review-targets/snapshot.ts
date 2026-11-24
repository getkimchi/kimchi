import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitBytes, gitResultError, gitText } from "./git.js"
import { assertNoConversionDrivers, workingTreeCandidatePaths } from "./preflight.js"
import type { RemovedReviewSnapshot, WorkingTreeStatus } from "./types.js"
import { ReviewTargetError } from "./types.js"

export const REVIEW_SNAPSHOT_REF_PREFIX = "refs/kimchi/review/snapshots/"
const INDEX_FLAG_DISPLAY_LIMIT = 20
const CLEANUP_TIMEOUT_MS = 30_000

interface StatusEntry {
	path: string
	submodule: boolean
	unmerged: boolean
}

export interface WorkingTreeSnapshot {
	tipSha: string
	headSha: string
	dirty: boolean
	ref?: string
	cleanup: () => Promise<void>
}

export interface SnapshotOptions {
	signal?: AbortSignal
	beforeSnapshotCommit?: () => void | Promise<void>
}

export interface WorkingTreeInspection {
	status: WorkingTreeStatus
	flaggedPaths: string[]
	flaggedPathCount: number
}

interface IndexFlaggedPath {
	path: string
	flags: string[]
}

function statusPaths(output: Buffer): StatusEntry[] {
	const fields = output.toString("utf8").split("\0")
	const entries: StatusEntry[] = []
	for (let index = 0; index < fields.length; index += 1) {
		const entry = fields[index]
		if (!entry) continue
		const kind = entry[0]
		if (kind === "?" || kind === "!") {
			entries.push({ path: entry.slice(2), submodule: false, unmerged: false })
			continue
		}
		const columns = entry.split(" ")
		if (kind === "1") {
			if (columns.length < 9) throw new ReviewTargetError("git_status", "Git returned a malformed status entry.")
			entries.push({
				path: columns.slice(8).join(" "),
				submodule: columns[2].startsWith("S"),
				unmerged: false,
			})
			continue
		}
		if (kind === "u") {
			if (columns.length < 11) throw new ReviewTargetError("git_status", "Git returned a malformed conflict entry.")
			entries.push({ path: columns.slice(10).join(" "), submodule: columns[2].startsWith("S"), unmerged: true })
			continue
		}
		if (kind === "2") {
			throw new ReviewTargetError("git_status", "Git returned an unexpected rename status entry.")
		}
		throw new ReviewTargetError("git_status", `Git returned unsupported status entry kind "${kind}".`)
	}
	return entries
}

async function workingTreeStatus(root: string, signal?: AbortSignal): Promise<StatusEntry[]> {
	const result = await gitBytes(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--no-renames"], {
		signal,
	})
	return statusPaths(result.stdout)
}

async function indexFlaggedPaths(root: string, signal?: AbortSignal): Promise<IndexFlaggedPath[]> {
	const output = await gitBytes(root, ["ls-files", "-v", "-z"], { signal })
	const flagged: IndexFlaggedPath[] = []
	for (const entry of output.stdout.toString("utf8").split("\0")) {
		if (!entry) continue
		const flags: string[] = []
		if (entry[0] === "h" || entry[0] === "s") flags.push("assume-unchanged")
		if (entry[0] === "S" || entry[0] === "s") flags.push("skip-worktree")
		if (flags.length) flagged.push({ path: entry.slice(2), flags })
	}
	return flagged
}

function flaggedPathMessage(flagged: IndexFlaggedPath[]): string {
	const paths = flagged
		.slice(0, INDEX_FLAG_DISPLAY_LIMIT)
		.map(({ path, flags }) => `${path} (${flags.join(" + ")})`)
		.join(", ")
	return flagged.length > INDEX_FLAG_DISPLAY_LIMIT
		? `${paths}, and ${flagged.length - INDEX_FLAG_DISPLAY_LIMIT} more`
		: paths
}

async function assertNoIndexVisibilityFlags(root: string, signal?: AbortSignal): Promise<void> {
	const flagged = await indexFlaggedPaths(root, signal)
	if (flagged.length) {
		throw new ReviewTargetError(
			"unsupported_index_flags",
			`Working-tree targets do not support assume-unchanged or skip-worktree paths: ${flaggedPathMessage(flagged)}. Clear those flags before reviewing the final working tree.`,
		)
	}
}

export async function inspectWorkingTree(root: string, signal?: AbortSignal): Promise<WorkingTreeInspection> {
	const flagged = await indexFlaggedPaths(root, signal)
	if (flagged.length) {
		return {
			status: "possible-edits",
			flaggedPaths: flagged.slice(0, INDEX_FLAG_DISPLAY_LIMIT).map(({ path }) => path),
			flaggedPathCount: flagged.length,
		}
	}
	return {
		status: (await workingTreeStatus(root, signal)).length ? "edits" : "clean",
		flaggedPaths: [],
		flaggedPathCount: 0,
	}
}

async function gitlinks(root: string, treeish: string, signal?: AbortSignal): Promise<Map<string, string>> {
	const result = await gitBytes(root, ["ls-tree", "-r", "-z", treeish], { signal })
	const links = new Map<string, string>()
	for (const entry of result.stdout.toString("utf8").split("\0")) {
		if (!entry) continue
		const separator = entry.indexOf("\t")
		const metadata = separator === -1 ? "" : entry.slice(0, separator).split(" ")
		if (metadata[0] === "160000" && metadata[1] === "commit") {
			links.set(entry.slice(separator + 1), metadata[2])
		}
	}
	return links
}

async function assertGitlinksUnchanged(
	root: string,
	headSha: string,
	treeSha: string,
	signal?: AbortSignal,
): Promise<void> {
	const [before, after] = await Promise.all([gitlinks(root, headSha, signal), gitlinks(root, treeSha, signal)])
	const changed =
		before.size !== after.size ||
		[...before].some(([path, object]) => after.get(path) !== object) ||
		[...after.keys()].some((path) => !before.has(path))
	if (changed) {
		throw new ReviewTargetError(
			"unsupported_submodule",
			"Working-tree snapshots do not support added, removed, or changed submodule revisions.",
		)
	}
}

function pathspecInput(paths: string[]): Buffer {
	return Buffer.from(paths.map((path) => `${path}\0`).join(""))
}

async function captureTree(
	root: string,
	env: Record<string, string>,
	tipSha: string,
	paths: string[],
	signal?: AbortSignal,
): Promise<string> {
	await gitText(root, ["read-tree", tipSha], { env, signal })
	if (paths.length) {
		await gitText(root, ["add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"], {
			env,
			signal,
			input: pathspecInput(paths),
		})
	}
	return (await gitText(root, ["write-tree"], { env, signal })).trim()
}

async function assertCaptureStable(
	root: string,
	env: Record<string, string>,
	tipSha: string,
	capturedPaths: string[],
	treeSha: string,
	signal?: AbortSignal,
): Promise<void> {
	const currentPaths = await workingTreeCandidatePaths(root, signal)
	if (
		currentPaths.length !== capturedPaths.length ||
		currentPaths.some((path, index) => path !== capturedPaths[index])
	) {
		throw new ReviewTargetError(
			"snapshot_changed",
			"The set of modified files changed while the working tree was being captured. Retry without concurrent edits.",
		)
	}
	// git diff does not consistently support --pathspec-from-file. Recapture
	// through the same literal stdin pathspec and compare immutable tree IDs.
	const verificationTree = await captureTree(root, env, tipSha, capturedPaths, signal)
	const untracked = await gitBytes(root, ["ls-files", "-z", "--others", "--exclude-standard"], { env, signal })
	if (verificationTree !== treeSha || untracked.stdout.length > 0) {
		throw new ReviewTargetError(
			"snapshot_changed",
			"A file changed or an untracked file appeared while the working tree was being captured. Retry without concurrent edits.",
		)
	}
}

/**
 * Freeze final on-disk contents using only a temporary index and private objects/refs.
 * The user's HEAD, index, working tree and stash are never used as mutation targets.
 */
export async function freezeWorkingTree(
	root: string,
	tipSha: string,
	options: SnapshotOptions = {},
): Promise<WorkingTreeSnapshot> {
	const capturedPaths = await assertNoConversionDrivers(root, options.signal)
	await assertNoIndexVisibilityFlags(root, options.signal)
	const entries = await workingTreeStatus(root, options.signal)
	if (!entries.length) {
		return { tipSha, headSha: tipSha, dirty: false, cleanup: async () => {} }
	}
	if (entries.some((entry) => entry.unmerged)) {
		throw new ReviewTargetError(
			"unmerged_paths",
			"Cannot snapshot a working tree with unmerged paths. Resolve or abandon the merge first.",
		)
	}
	if (entries.some((entry) => entry.submodule)) {
		throw new ReviewTargetError(
			"unsupported_submodule",
			"Working-tree snapshots do not support staged, unstaged, or untracked submodule changes.",
		)
	}
	const sparse = await gitText(root, ["config", "--type=bool", "--default=false", "--get", "core.sparseCheckout"], {
		signal: options.signal,
	})
	if (sparse.trim() === "true") {
		throw new ReviewTargetError(
			"unsupported_sparse_checkout",
			"Working-tree snapshots in sparse checkouts are not supported; use a full checkout.",
		)
	}

	const temporaryDirectory = await mkdtemp(join(tmpdir(), "kimchi-review-index-"))
	const indexFile = join(temporaryDirectory, "index")
	const env = { GIT_INDEX_FILE: indexFile }
	try {
		const treeSha = await captureTree(root, env, tipSha, capturedPaths, options.signal)
		await assertGitlinksUnchanged(root, tipSha, treeSha, options.signal)
		await options.beforeSnapshotCommit?.()
		await assertCaptureStable(root, env, tipSha, capturedPaths, treeSha, options.signal)
		const currentHead = await gitText(root, ["rev-parse", "--verify", "HEAD"], { signal: options.signal })
		if (currentHead.trim() !== tipSha) {
			throw new ReviewTargetError(
				"checkout_changed",
				"The checkout HEAD changed while the working tree was being captured. Retry from a stable checkout.",
			)
		}
		const now = `@${Math.floor(Date.now() / 1000)} +0000`
		const identity = {
			...env,
			GIT_AUTHOR_NAME: "Kimchi Review",
			GIT_AUTHOR_EMAIL: "review@localhost",
			GIT_COMMITTER_NAME: "Kimchi Review",
			GIT_COMMITTER_EMAIL: "review@localhost",
			GIT_AUTHOR_DATE: now,
			GIT_COMMITTER_DATE: now,
		}
		const headSha = (
			await gitText(root, ["commit-tree", treeSha, "-p", tipSha], {
				env: identity,
				input: "Freeze working tree for local review\n",
				signal: options.signal,
			})
		).trim()
		if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(headSha)) {
			throw new ReviewTargetError("snapshot_capture", "Git returned an invalid snapshot commit ID.")
		}
		const snapshotRef = `${REVIEW_SNAPSHOT_REF_PREFIX}${randomUUID()}`
		await gitText(root, ["update-ref", snapshotRef, headSha, ""], { signal: options.signal })
		return {
			tipSha,
			headSha,
			dirty: true,
			ref: snapshotRef,
			cleanup: async () => {
				// The caller may have aborted the completed resolution long ago. Cleanup
				// gets its own bounded lifetime instead of inheriting that cancellation.
				await deleteSnapshotRef(root, snapshotRef, headSha, AbortSignal.timeout(CLEANUP_TIMEOUT_MS))
			},
		}
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true })
	}
}

export async function deleteSnapshotRef(
	root: string,
	ref: string,
	expectedHeadSha: string,
	signal?: AbortSignal,
): Promise<boolean> {
	if (!ref.startsWith(REVIEW_SNAPSHOT_REF_PREFIX) || ref.slice(REVIEW_SNAPSHOT_REF_PREFIX.length).includes("/")) {
		throw new ReviewTargetError("invalid_snapshot_ref", `Ref ${ref} is outside the private review snapshot namespace.`)
	}
	const args = ["show-ref", "--verify", "--quiet", ref] as const
	const current = await gitBytes(root, args, { signal, allowFailure: true })
	if (current.exitCode === 1 && current.failure?.code === 1 && !current.stderr) return false
	if (current.exitCode !== 0) throw gitResultError(args, current)
	const object = (await gitText(root, ["rev-parse", "--verify", "--end-of-options", ref], { signal })).trim()
	if (object !== expectedHeadSha) {
		throw new ReviewTargetError("snapshot_ref_changed", `Ref ${ref} no longer points to the snapshot being cleaned up.`)
	}
	await gitText(root, ["update-ref", "-d", ref, expectedHeadSha], { signal })
	return true
}

export async function removeStaleSnapshots(
	root: string,
	olderThanMs: number,
	signal?: AbortSignal,
): Promise<RemovedReviewSnapshot[]> {
	if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
		throw new ReviewTargetError("invalid_snapshot_age", "olderThanMs must be a finite, non-negative number.")
	}
	const cutoff = Math.floor((Date.now() - olderThanMs) / 1000)
	const output = await gitText(
		root,
		["for-each-ref", "--format=%(refname)%00%(objectname)%00%(committerdate:unix)", REVIEW_SNAPSHOT_REF_PREFIX],
		{ signal },
	)
	const removed: RemovedReviewSnapshot[] = []
	for (const line of output.split("\n")) {
		if (!line) continue
		const [ref, headSha, timestamp, ...extra] = line.split("\0")
		if (extra.length || !ref || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(headSha)) {
			throw new ReviewTargetError("stale_snapshot_scan", "Git returned malformed snapshot ref metadata.")
		}
		if (!/^\d+$/.test(timestamp) || Number(timestamp) >= cutoff) continue
		if (await deleteSnapshotRef(root, ref, headSha, signal)) removed.push({ ref, headSha })
	}
	return removed
}
