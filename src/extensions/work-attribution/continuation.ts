import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { readdir, readFile, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { getAgentDir, parseSkillBlock } from "@earendil-works/pi-coding-agent"
import { readPlanWorkId } from "../../shared/planning/plan-markdown.js"
import type { WorkContext } from "../work-attribution.js"
import { type FileTransition, readAttributedFileState, readRepositoryTransitions } from "./file-transitions.js"
import { captureWorkScope, readWorkScope, sameWorkScope, type WorkAccount, type WorkScopeSnapshot } from "./scope.js"
import { readWorkRecords } from "./summary.js"

const MARKDOWN_REFERENCE = /(?:^|[\s@'"`([])([^\s@'"`()[\]<>#]+\.md)(?:#[^\s'"`()[\]<>]*)?(?=$|[\s'"`()[\],;:.!?])/gi
const FILE_REFERENCE =
	/(?:^|[\s@'"`([])([^\s@'"`()[\]<>#]*[/.][^\s@'"`()[\]<>#,:;!?]+)(?:#[^\s'"`()[\]<>]*)?(?=$|[\s'"`()[\],;.!?]|:\d)/gi
const NATIVE_PLAN_PATH = /\/(?:\.kimchi\/plans|work\/[\da-f-]{36}\/plans)\/[^/]+\.md$/i

/** The user's own text: RPC clients can pass an already expanded skill, whose body the user did not write. */
export function userText(text: string): string {
	const normalized = text.replaceAll("\r\n", "\n")
	const skill = parseSkillBlock(normalized)
	return skill ? (skill.userMessage ?? "") : normalized
}

/** Unresolved explicit references must not be overridden by a semantic guess. */
export function hasWorkReference(text: string): boolean {
	const message = userText(text)
	return message.includes("<!-- kimchi-work-id:") || [...message.matchAll(MARKDOWN_REFERENCE)].length > 0
}

export interface WorkContinuation {
	workId: string
	source: "saved-plan" | "pasted-plan" | "named-artifact" | "semantic"
	evidence: {
		path: string
		contentHash?: string
		requestId?: string
		transitionId?: string
		repository?: string
		worktree?: string
		branch?: string
		recordedAt?: string
		model?: string
		decision?: "same" | "continue" | "new" | "unknown"
		inputHash?: string
		segmentId?: string
		promptVersion?: number
		candidateWorkIds?: string[]
		account?: WorkAccount
	}
}
function artifactMatch(row: FileTransition, path: string): WorkContinuation {
	return {
		workId: row.workId,
		source: "named-artifact",
		evidence: {
			path,
			transitionId: row.transitionId,
			repository: row.repository,
			worktree: row.worktree,
			branch: row.branch,
			recordedAt: row.recordedAt,
		},
	}
}
function recordedTime(row: FileTransition): number {
	return row.recordedAt ? Date.parse(row.recordedAt) || 0 : 0
}
function latest(rows: FileTransition[]): FileTransition | undefined {
	return rows.reduce<FileTransition | undefined>(
		(last, row) => (!last || recordedTime(row) >= recordedTime(last) ? row : last),
		undefined,
	)
}
async function unchanged(row: FileTransition, path: string): Promise<boolean> {
	const current = await readAttributedFileState(path)
	return current?.blob === row.after.blob && current.mode === row.after.mode
}
/** Whether the real `path` lies in `worktree` itself rather than in a repository nested inside it. */
async function inWorktree(worktree: string, path: string): Promise<boolean> {
	const inside = relative(worktree, path)
	if (inside.startsWith("..") || isAbsolute(inside)) return false
	for (let directory = dirname(path); directory.length > worktree.length; directory = dirname(directory))
		if (await realpath(join(directory, ".git")).catch(() => undefined)) return false
	return true
}
async function namedArtifact(
	cwd: string,
	named: string,
	transitions: (directory: string, path: string) => ReturnType<typeof readRepositoryTransitions>,
): Promise<{ owners: string[]; match?: WorkContinuation } | undefined> {
	const resolved = resolve(cwd, named)
	let directory = dirname(resolved)
	let path = resolved
	let native: { owners: string[]; match?: WorkContinuation } | undefined
	while (true) {
		try {
			// A missing output directory can still have ownership evidence from a deleted file.
			path = join(await realpath(directory), relative(directory, resolved))
			break
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return
			if (dirname(directory) === directory) return
			directory = dirname(directory)
		}
	}
	if (NATIVE_PLAN_PATH.test(path)) {
		try {
			const content = await readFile(path)
			const normalized = content.toString("utf8").replaceAll("\r\n", "\n")
			const workId = readPlanWorkId(normalized)
			if (workId) {
				const verified = await pastedPlans(normalized)
				const exact = verified?.matches.length === 1 && !verified.remaining.trim()
				native = {
					owners: [workId],
					match: exact
						? {
								workId,
								source: "saved-plan",
								evidence: { path, contentHash: createHash("sha256").update(content).digest("hex") },
							}
						: undefined,
				}
			}
		} catch {
			// A deleted plan keeps the works its plan records name. Missing files still pass the ownership check below.
			const owners = savedPlanOwners(path)
			if (owners.length) native = { owners }
		}
	}
	const evidence = await transitions(directory, path)
	// No transition can own a path outside every Git worktree.
	if (evidence === null) return native ?? { owners: [] }
	if (!evidence) return native
	const repositoryPath = relative(evidence.worktree, path)
	const rows = evidence.transitions.filter(
		(row) => row.repository === evidence.repository && row.path === repositoryPath,
	)
	const owners = [...new Set([...(native?.owners ?? []), ...rows.map((row) => row.workId)])]
	if (native) return { owners, match: owners.length === 1 ? native.match : undefined }
	const row = latest(rows)
	return {
		owners,
		match:
			path.endsWith(".md") && owners.length === 1 && row && (await unchanged(row, path))
				? artifactMatch(row, path)
				: undefined,
	}
}

/** Journals are never pruned, so they are read only for a native plan path that no longer exists. */
function savedPlanOwners(path: string): string[] {
	const canonical = (saved: string) => {
		try {
			return join(realpathSync(dirname(saved)), basename(saved))
		} catch {
			return saved
		}
	}
	return readWorkRecords(getAgentDir()).flatMap((row) => {
		const cwd = row.cwd
		if (row.type !== "plan" || typeof cwd !== "string") return []
		const named = [row.path, row.snapshotPath].some(
			(saved) =>
				typeof saved === "string" && basename(saved) === basename(path) && canonical(resolve(cwd, saved)) === path,
		)
		return named ? [row.workId] : []
	})
}

async function pastedPlans(text: string): Promise<{ matches: WorkContinuation[]; remaining: string } | undefined> {
	const matches: WorkContinuation[] = []
	let end = 0
	let remaining = ""
	for (const marker of text.matchAll(/^<!-- kimchi-work-id: [^\n]* -->$/gm)) {
		if (marker.index < end) continue // Metadata examples inside a verified plan are just plan content.
		const workId = readPlanWorkId(marker[0])
		if (!workId) return
		const directory = join(getAgentDir(), "work", workId, "plans")
		const pasted = text.slice(marker.index)
		let found: { path: string; length: number; contentHash: string } | undefined
		try {
			for (const file of await readdir(directory, { withFileTypes: true })) {
				if (!file.isFile() || !file.name.endsWith(".md")) continue
				const path = join(directory, file.name)
				const saved = await readFile(path)
				const content = saved.toString("utf8").replaceAll("\r\n", "\n").trimEnd()
				if (
					readPlanWorkId(content) === workId &&
					content.length > marker[0].length &&
					pasted.startsWith(content) &&
					(pasted.length === content.length || pasted[content.length] === "\n") &&
					content.length > (found?.length ?? 0)
				)
					found = { path, length: content.length, contentHash: createHash("sha256").update(saved).digest("hex") }
			}
		} catch {
			return
		}
		if (!found) return
		matches.push({ workId, source: "pasted-plan", evidence: { path: found.path, contentHash: found.contentHash } })
		remaining += text.slice(end, marker.index)
		end = marker.index + found.length
	}
	return { matches, remaining: remaining + text.slice(end) }
}

/**
 * Resolve identity before dispatch, and whether the input names any recorded work. Nothing is continued without a
 * captured scope. The caller owns fresh-session and explicit-selection gates.
 */
export async function findWorkContinuation(
	ctx: Pick<WorkContext, "cwd">,
	text: string,
	captured: WorkScopeSnapshot | undefined,
): Promise<{ match?: WorkContinuation; owned: boolean }> {
	const pasted = await pastedPlans(userText(text))
	// A work marker names recorded work even when its plan cannot be verified.
	if (!pasted || pasted.remaining.includes("<!-- kimchi-work-id:")) return { owned: true }
	const paths = new Set([...pasted.remaining.matchAll(FILE_REFERENCE)].map((match) => match[1].replace(/\.+$/, "")))
	// Extensionless names such as Makefile need no path syntax to have a recorded owner.
	const words = new Set(pasted.remaining.split(/[\s@'"`()[\]<>#,;:!?]+/).map((word) => word.replace(/\.+$/, "")))
	const evidence = await readRepositoryTransitions(ctx.cwd)
	for (const row of evidence?.transitions ?? []) {
		const path = relative(ctx.cwd, resolve(row.worktree, row.path))
		if (!path.includes("/") && words.has(path)) paths.add(path)
	}
	// Every dotted or slashed word may be a path. Paths in this worktree reuse its evidence, and each other
	// directory is read once, so URLs and stack traces start no Git process per word.
	const reads = new Map([[ctx.cwd, Promise.resolve(evidence)]])
	const transitions = async (directory: string, path: string) => {
		if (evidence && (await inWorktree(evidence.worktree, path))) return evidence
		if (!reads.has(directory)) reads.set(directory, readRepositoryTransitions(directory))
		return reads.get(directory)
	}
	const named = await Promise.all([...paths].map((path) => namedArtifact(ctx.cwd, path, transitions)))
	// Markdown names plans and artifacts; other owned files only compete with a continuation.
	const owned =
		pasted.matches.length > 0 || [...paths].some((path, index) => /\.md$/i.test(path) && !!named[index]?.owners.length)
	if (named.some((file) => !file)) return { owned } // Unreadable evidence is not proof that a file has no owner.
	const matches = [...pasted.matches, ...named.flatMap((file) => (file?.match ? [file.match] : []))]
	if (new Set(matches.map((match) => match.workId)).size !== 1) return { owned }
	const match = matches[0]
	if (named.some((file) => file?.owners.some((owner) => owner !== match.workId))) return { owned }
	const owner = readWorkScope(match.workId)
	if (!owner || !captured?.isCurrent() || !sameWorkScope(owner, captured.scope)) return { owned }
	const current = await captureWorkScope(ctx.cwd)
	const verified = current && sameWorkScope(current.scope, captured.scope) && captured.isCurrent()
	return { match: verified ? match : undefined, owned }
}
