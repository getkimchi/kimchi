/**
 * verifier-guard.ts — the Ferment V2 verifier's evidence stamping and
 * workspace integrity guard.
 *
 * The guard runs as an inline extension inside the verifier subagent's child
 * session (it loads even though the Verifier persona disables extensions):
 *
 * - every `tool_result` is prefixed with a host-stamped evidence ID `[eN]`;
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
import { isAbsolute, relative, resolve } from "node:path"
import type { Usage } from "@earendil-works/pi-ai"
import type { InlineExtension } from "@earendil-works/pi-coding-agent"
import { isRecord } from "./reducer.js"
import type { FermentV2EvaluatorUsage } from "./types.js"
import {
	createGitRunner,
	diffSnapshots,
	type HeadState,
	readHeadState,
	removePaths,
	restorePaths,
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

/** A path and its symlink-resolved form (macOS keeps the temp dir under /private). */
function pathForms(path: string): string[] {
	try {
		const resolved = realpathSync(path)
		return resolved === path ? [path] : [path, resolved]
	} catch {
		return [path]
	}
}

function isInsideAny(path: string, roots: readonly string[]): boolean {
	return roots.some((root) => {
		const rel = relative(root, path)
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
	})
}

function pathExists(path: string): boolean {
	try {
		lstatSync(path)
		return true
	} catch {
		return false
	}
}

/**
 * Whether the verifier may write `rawPath` (relative paths resolve against
 * `cwd`): anything inside the disposable baseline worktree, and new files —
 * nothing that exists yet — inside the repository. Shared by the guard (which
 * blocks every other write) and the permissions pre-approval (so these writes
 * never wait on the classifier).
 */
export function isVerifierWritablePath(rawPath: unknown, roots: { cwd?: string; worktree?: string }): boolean {
	if (typeof rawPath !== "string" || !rawPath.trim()) return false
	const base = roots.cwd ?? roots.worktree
	if (!base) return false
	const target = resolve(base, rawPath)
	if (roots.worktree && isInsideAny(target, pathForms(roots.worktree))) return true
	return roots.cwd !== undefined && isInsideAny(target, pathForms(roots.cwd)) && !pathExists(target)
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
	const usage: FermentV2EvaluatorUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		costUsd: 0,
	}
	let nextEvidenceId = 1

	const addUsage = (u: Usage): void => {
		usage.input += u.input ?? 0
		usage.output += u.output ?? 0
		usage.cacheRead += u.cacheRead ?? 0
		usage.cacheWrite += u.cacheWrite ?? 0
		usage.totalTokens += u.totalTokens ?? 0
		usage.costUsd += u.cost?.total ?? 0
	}

	const extension: InlineExtension = (pi) => {
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

	return { extension, evidence, createdFiles, usage }
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
export async function enforceWorkspaceIntegrity(
	cwd: string,
	before: WorkspaceSnapshot,
	beforeHead: HeadState | undefined,
	signal?: AbortSignal,
): Promise<IntegrityResult> {
	const git = createGitRunner(cwd)
	const after = await snapshotWorkspace(cwd, signal)
	if (!after) return { violated: false, restored: [], removed: [], headMoved: false, unenforced: true }
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
	if (diff.added.length > 0) {
		await removePaths(cwd, diff.added)
		result.removed = diff.added
	}
	return result
}
