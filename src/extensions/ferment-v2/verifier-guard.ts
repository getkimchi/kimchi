/**
 * verifier-guard.ts — the Ferment V2 verifier's evidence stamping and
 * workspace integrity guard.
 *
 * The guard runs as an inline extension inside the verifier subagent's child
 * session (it loads even though the Verifier persona disables extensions):
 *
 * - verification `tool_result`s receive host evidence IDs `[eN]`;
 *   the verifier's report tools are metadata and excluded;
 *   verdicts may cite only these IDs (host validation rejects unknown IDs);
 * - assistant usage is accumulated per `message_end`, and summarization usage
 *   per `session_compact` (the compaction completion produces no assistant
 *   message), both including cost — so upstream compaction, which rewrites
 *   the session's messages, cannot erase the usage of discarded messages;
 * - the baseline worktree, when one is reserved, is checked out on the first
 *   tool call that references its path (a run that never uses it costs no
 *   checkout); a failed checkout blocks that call with a reason;
 * - `write`/`edit` are confined: anything inside the disposable baseline
 *   worktree, and only *new* files inside the repository (probes, baseline
 *   copies of flagged tests) — an existing repository file or a path outside
 *   both roots is blocked before it is touched;
 * - `enforceWorkspaceIntegrity` runs after the verifier (including on abort):
 *   modified/deleted pre-existing files are restored, files the verifier added
 *   are removed, and HEAD moves — branch switches and detachments, even at the
 *   same commit, including transitions to or from an unborn HEAD (`git checkout
 *   --orphan`) — are detected without git surgery.
 *
 * The snapshot/diff/restore primitives it builds on live in `workspace.ts`.
 */

import { lstatSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import type { Usage } from "@earendil-works/pi-ai"
import type { ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent"
import { isRecord } from "./reducer.js"
import type { FermentV2EvaluatorUsage } from "./types.js"
import {
	createGitRunner,
	diffSnapshots,
	type HeadState,
	listSnapshotPaths,
	readHeadState,
	removePaths,
	restorePaths,
	type SnapshotPaths,
	snapshotWorkspace,
	type WorkspaceSnapshot,
} from "./workspace.js"

/** Maximum characters of a tool result kept as the evidence excerpt. */
const EVIDENCE_EXCERPT_CHARS = 2_000

export interface VerifierEvidence {
	id: string
	toolName: string
	input: Record<string, unknown>
	isError: boolean
	excerpt: string
}

/** The baseline worktree the guard materialises on first reference. */
export interface LazyBaselineWorktree {
	path: string
	ensure(): Promise<boolean>
}

export interface VerifierGuardOptions {
	baselineWorktree?: LazyBaselineWorktree
	/** The repository the verifier runs in; `write` may create new files inside it. Without it, writes are confined to the worktree. */
	cwd?: string
	/** Tools whose results are review metadata (the report tools), never stamped as evidence. */
	metadataTools?: readonly string[]
}

export interface VerifierGuard {
	extension: InlineExtension
	evidence: ReadonlyMap<string, VerifierEvidence>
	/** Absolute paths the verifier created with a successful `write` in this run (probes, baseline test copies). */
	createdFiles: ReadonlySet<string>
	/**
	 * Verifier usage accumulated per assistant `message_end` and per
	 * `session_compact` event, including cost. Event-based accumulation
	 * survives upstream compaction, which rewrites `session.messages` and
	 * would drop the usage of discarded messages; the compaction's own
	 * summarization completion bills tokens no assistant message ever carries.
	 */
	usage: FermentV2EvaluatorUsage
}

/** Shared usage accumulator for host-spawned verifier sessions. */
export interface UsageAccumulator {
	/** Live totals; read after the run settles. */
	readonly usage: FermentV2EvaluatorUsage
	/** Registers the tracking handlers on a child session's extension API. */
	register: ExtensionFactory
}

export function createUsageAccumulator(): UsageAccumulator {
	const usage: FermentV2EvaluatorUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		costUsd: 0,
	}
	const addUsage = (u: Usage): void => {
		usage.input += u.input ?? 0
		usage.output += u.output ?? 0
		usage.cacheRead += u.cacheRead ?? 0
		usage.cacheWrite += u.cacheWrite ?? 0
		usage.totalTokens += u.totalTokens ?? 0
		usage.costUsd += u.cost?.total ?? 0
	}
	const register: ExtensionFactory = (pi) => {
		// Compaction runs a separate summarization completion that produces no
		// assistant message — its billed usage surfaces only on this event.
		pi.on("session_compact", (event) => {
			if (event.compactionEntry.usage) addUsage(event.compactionEntry.usage)
		})
		pi.on("message_end", (event) => {
			if (event.message.role !== "assistant") return
			const u = (event.message as { usage?: Usage }).usage
			if (u) addUsage(u)
		})
	}
	return { usage, register }
}

function textExcerpt(content: readonly unknown[]): string {
	const text = content
		.map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("\n")
		.trim()
	return text.length > EVIDENCE_EXCERPT_CHARS ? `${text.slice(0, EVIDENCE_EXCERPT_CHARS)}…` : text
}

/** Whether any string in a tool input (nested objects and arrays included) mentions one of the paths. */
function inputMentions(value: unknown, paths: readonly string[]): boolean {
	if (typeof value === "string") return paths.some((path) => value.includes(path))
	if (Array.isArray(value)) return value.some((item) => inputMentions(item, paths))
	if (isRecord(value)) return Object.values(value).some((item) => inputMentions(item, paths))
	return false
}

function pathExists(path: string): boolean {
	try {
		lstatSync(path)
		return true
	} catch {
		return false
	}
}

/** Resolve symlinked parents even when the target file does not exist yet. */
function resolvedDestination(path: string): string | undefined {
	let ancestor = path
	while (!pathExists(ancestor)) {
		const parent = dirname(ancestor)
		if (parent === ancestor) return undefined
		ancestor = parent
	}
	try {
		return resolve(realpathSync(ancestor), relative(ancestor, path))
	} catch {
		// A dangling or looping symlink is not a safe write destination.
		return undefined
	}
}

/** A path and its symlink-resolved form (macOS keeps the temp dir under /private). */
function pathForms(path: string): string[] {
	const resolved = resolvedDestination(path)
	return resolved && resolved !== path ? [path, resolved] : [path]
}

function isInsideAny(path: string, roots: readonly string[]): boolean {
	return roots.some((root) => {
		const rel = relative(root, path)
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
	})
}

/**
 * Whether the verifier may write `rawPath` (relative paths resolve against
 * `cwd`): anything inside the disposable baseline worktree, and new files —
 * nothing that exists yet — inside the repository. Shared by the guard (which
 * blocks every other write) and the permissions pre-approval (so these writes
 * never wait on the classifier).
 */
function hasGitMetadataSegment(path: string): boolean {
	return path.split(/[\\/]+/).some((segment) => segment.toLowerCase() === ".git")
}

export function isVerifierWritablePath(rawPath: unknown, roots: { cwd?: string; worktree?: string }): boolean {
	if (typeof rawPath !== "string" || !rawPath.trim()) return false
	const base = roots.cwd ?? roots.worktree
	if (!base) return false
	const target = resolve(base, rawPath)
	const destination = resolvedDestination(target)
	if (!destination || hasGitMetadataSegment(target) || hasGitMetadataSegment(destination)) return false
	if (roots.worktree && isInsideAny(target, pathForms(roots.worktree))) {
		const worktree = resolvedDestination(roots.worktree)
		return worktree !== undefined && isInsideAny(destination, [worktree])
	}
	if (roots.cwd && isInsideAny(target, pathForms(roots.cwd))) {
		const cwd = resolvedDestination(roots.cwd)
		return cwd !== undefined && isInsideAny(destination, [cwd]) && !pathExists(target)
	}
	return false
}

/**
 * The verifier's in-session guard: every tool result is stamped with a
 * sequential evidence ID, usage is accumulated as assistant messages
 * complete and as compactions run (so it can be counted even after
 * compaction), and the reserved baseline worktree is checked out on the
 * first tool call that references it.
 */
export function createVerifierGuard(options: VerifierGuardOptions = {}): VerifierGuard {
	const worktree = options.baselineWorktree
	const worktreePaths = worktree ? pathForms(worktree.path) : []
	const writableRoots = { cwd: options.cwd, worktree: worktree?.path }
	const evidence = new Map<string, VerifierEvidence>()
	const createdFiles = new Set<string>()
	const metadataTools = new Set(options.metadataTools ?? [])
	const usageTracker = createUsageAccumulator()
	let nextEvidenceId = 1

	const extension: InlineExtension = (pi) => {
		usageTracker.register(pi)
		if (worktree) {
			pi.on("tool_call", async (event) => {
				if (!inputMentions(event.input, worktreePaths)) return undefined
				if (await worktree.ensure()) return undefined
				return {
					block: true,
					reason: `The baseline worktree ${worktree.path} could not be created. Attribute failures without it and treat attribution as uncertain.`,
				}
			})
		}
		// Registered after the worktree hook, so a write into the worktree sees it
		// checked out (an overwrite there is fine; it is disposable).
		pi.on("tool_call", (event) => {
			if (event.toolName !== "write" && event.toolName !== "edit") return undefined
			const path = isRecord(event.input) ? event.input.path : undefined
			if (isVerifierWritablePath(path, writableRoots)) return undefined
			return {
				block: true,
				reason:
					"Verifier writes are limited to NEW files inside the repository (probes, baseline copies of flagged tests) and to files inside the baseline worktree. Never modify an existing repository file — write a new file next to it instead.",
			}
		})
		pi.on("tool_result", (event) => {
			// Reporting is metadata about the review, never evidence of task completion.
			if (metadataTools.has(event.toolName)) return undefined
			if (event.toolName === "write" && !event.isError && typeof event.input.path === "string") {
				const base = options.cwd ?? worktree?.path
				if (base) createdFiles.add(resolve(base, event.input.path))
			}
			const id = `e${nextEvidenceId++}`
			evidence.set(id, {
				id,
				toolName: event.toolName,
				input: event.input,
				isError: event.isError,
				excerpt: textExcerpt(event.content),
			})
			const content = event.content.map((part) =>
				part.type === "text" ? { ...part, text: `[${id}] ${part.text}` } : part,
			)
			return { content }
		})
	}

	return {
		extension,
		evidence,
		createdFiles,
		usage: usageTracker.usage,
	}
}

/**
 * Heads match only when the commit and the symbolic-ref target (branch, or
 * detached on both sides) are unchanged — a branch switch or a detachment
 * at the same commit is a HEAD move.
 */
function sameHeadState(before: HeadState, after: HeadState): boolean {
	if (before.kind === "commit" && after.kind === "commit") return before.sha === after.sha && before.ref === after.ref
	if (before.kind === "unborn" && after.kind === "unborn") return before.ref === after.ref
	return false
}

export interface IntegrityResult {
	violated: boolean
	restored: string[]
	removed: string[]
	headMoved: boolean
	/** Snapshot commit of the working tree right after the run — recovery point for the user. */
	postRunSnapshot?: string
	/**
	 * True when the host could not protect the working tree for this run: the
	 * before-run snapshot failed (the verifier ran without the guard), or the
	 * post-run snapshot failed (verifier changes could not be detected).
	 */
	unenforced?: boolean
}

/**
 * Enforce workspace integrity after a verifier run (also on abort): snapshot
 * the current tree, restore modified/deleted pre-existing files from the
 * before-run snapshot, remove files the verifier added, and detect HEAD moves
 * — including transitions between resolved and unborn HEAD — without
 * attempting git surgery. HEAD-move detection is skipped when the before-run
 * HEAD could not be resolved.
 */
export interface WorkspaceIntegrityOptions {
	/** Successful host-visible `write` calls from this run, used to remove new ignored files too. */
	createdFiles?: ReadonlySet<string>
	/** Test seam for post-run snapshot failures. */
	afterSnapshot?: typeof snapshotWorkspace
}

function newCreatorRelativePaths(before: SnapshotPaths, createdFiles: ReadonlySet<string> | undefined): string[] {
	if (!createdFiles) return []
	const paths = new Set<string>()
	for (const absolute of createdFiles) {
		if (!pathExists(absolute)) continue
		const candidate = pathForms(absolute).find((path) => isInsideAny(path, [before.root]))
		if (!candidate) continue
		const path = relative(before.root, candidate).replaceAll("\\\\", "/")
		if (!before.paths.has(path)) paths.add(path)
	}
	return [...paths].sort()
}

export async function enforceWorkspaceIntegrity(
	cwd: string,
	before: WorkspaceSnapshot,
	beforeHead: HeadState | undefined,
	signal?: AbortSignal,
	options: WorkspaceIntegrityOptions = {},
): Promise<IntegrityResult> {
	const git = createGitRunner(cwd)
	const after = await (options.afterSnapshot ?? snapshotWorkspace)(cwd, signal)
	const beforePaths = !after || options.createdFiles?.size ? await listSnapshotPaths(cwd, before, signal) : undefined
	const creatorAdded = beforePaths ? newCreatorRelativePaths(beforePaths, options.createdFiles) : []
	if (!after) {
		if (!beforePaths) return { violated: false, restored: [], removed: [], headMoved: false, unenforced: true }
		// A failed after-snapshot cannot compare the two trees, but it must not
		// leave verifier damage in files known to the before-snapshot.
		const restored = [...beforePaths.paths].sort()
		if (restored.length) await restorePaths(cwd, before, restored, signal)
		if (creatorAdded.length) await removePaths(cwd, creatorAdded)
		return { violated: true, restored, removed: creatorAdded, headMoved: false, unenforced: true }
	}
	const result: IntegrityResult = {
		violated: false,
		restored: [],
		removed: [],
		headMoved: false,
		postRunSnapshot: after.commit,
	}
	// With a known before-run HEAD, HEAD must resolve after the run: a
	// resolution failure is an enforcement failure (it throws) rather than a
	// clean tree. Any HEAD move is a violation: a different commit or symbolic
	// ref, a branch switch or detachment at the same commit, or a transition
	// between resolved and unborn HEAD (e.g. `git checkout --orphan`).
	if (beforeHead !== undefined) {
		const afterHead = await readHeadState(git, signal)
		if (afterHead === undefined) throw new Error("git HEAD could not be resolved after the verifier run")
		if (!sameHeadState(beforeHead, afterHead)) {
			result.headMoved = true
			result.violated = true
		}
	}
	// A failed diff is an enforcement failure, not a clean tree: it propagates
	// so the host can discard an untrusted `met` verdict.
	const diff = await diffSnapshots(cwd, before, after, signal)
	const toRestore = [...diff.modified, ...diff.deleted]
	if (toRestore.length > 0) {
		await restorePaths(cwd, before, toRestore, signal)
		result.restored = toRestore
		result.violated = true
	}
	const removed = [...new Set([...diff.added, ...creatorAdded])].sort()
	if (removed.length > 0) {
		await removePaths(cwd, removed)
		result.removed = removed
		result.violated = true
	}
	return result
}
