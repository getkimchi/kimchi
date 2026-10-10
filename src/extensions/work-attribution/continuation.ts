import { readFileSync, realpathSync } from "node:fs"
import { readdir, readFile, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { getAgentDir, parseSkillBlock } from "@earendil-works/pi-coding-agent"
import { readPlanWorkId } from "../../shared/planning/plan-markdown.js"
import type { WorkContext } from "../work-attribution.js"
import { type FileTransition, readAttributedFileState, readRepositoryTransitions } from "./file-transitions.js"
import { captureWorkScope, readWorkScope, sameWorkScope, type WorkAccount, type WorkScopeSnapshot } from "./scope.js"
import type { WorkRecord } from "./summary.js"

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

/** Ordinary Markdown mentions do not select work; recorded owners and plan markers do. */
export function hasOwnedWorkReference(
	ctx: Pick<WorkContext, "cwd">,
	text: string,
	records: readonly WorkRecord[],
): boolean {
	const normalized = text.replaceAll("\r\n", "\n")
	const skill = parseSkillBlock(normalized)
	const message = skill ? (skill.userMessage ?? "") : normalized
	if (message.includes("<!-- kimchi-work-id:")) return true
	const canonical = (path: string) => {
		try {
			return join(realpathSync(dirname(path)), basename(path))
		} catch {
			return path
		}
	}
	const paths = new Set([...message.matchAll(MARKDOWN_REFERENCE)].map((match) => canonical(resolve(ctx.cwd, match[1]))))
	for (const path of paths) {
		if (!NATIVE_PLAN_PATH.test(path)) continue
		try {
			if (readPlanWorkId(readFileSync(path, "utf8"))) return true
		} catch {}
	}
	// Journals are never pruned: compare file names before resolving each row's directory.
	const names = new Set([...paths].map((path) => basename(path)))
	const owns = (root: string, path: unknown) => {
		if (typeof path !== "string") return false
		const resolved = resolve(root, path)
		return names.has(basename(resolved)) && paths.has(canonical(resolved))
	}
	return records.some((row) => {
		if (row.type === "plan" && typeof row.cwd === "string") {
			const cwd = row.cwd
			return [row.path, row.snapshotPath].some((path) => owns(cwd, path))
		}
		return row.type === "file_transition" && typeof row.worktree === "string" && owns(row.worktree, row.path)
	})
}

export interface WorkContinuation {
	workId: string
	source: "saved-plan" | "pasted-plan" | "named-artifact" | "semantic"
	evidence: {
		path: string
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
			const content = (await readFile(path, "utf8")).replaceAll("\r\n", "\n")
			const workId = readPlanWorkId(content)
			if (workId) {
				const verified = await pastedPlans(content)
				const exact = verified?.matches.length === 1 && !verified.remaining.trim()
				native = { owners: [workId], match: exact ? { workId, source: "saved-plan", evidence: { path } } : undefined }
			}
		} catch {
			// Missing files still have to pass the ownership check below.
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
		let found: { path: string; length: number } | undefined
		try {
			for (const file of await readdir(directory, { withFileTypes: true })) {
				if (!file.isFile() || !file.name.endsWith(".md")) continue
				const path = join(directory, file.name)
				const content = (await readFile(path, "utf8")).replaceAll("\r\n", "\n").trimEnd()
				if (
					readPlanWorkId(content) === workId &&
					content.length > marker[0].length &&
					pasted.startsWith(content) &&
					(pasted.length === content.length || pasted[content.length] === "\n") &&
					content.length > (found?.length ?? 0)
				)
					found = { path, length: content.length }
			}
		} catch {
			return
		}
		if (!found) return
		matches.push({ workId, source: "pasted-plan", evidence: { path: found.path } })
		remaining += text.slice(end, marker.index)
		end = marker.index + found.length
	}
	return { matches, remaining: remaining + text.slice(end) }
}

/** Resolve identity before dispatch; the caller owns fresh-session and explicit-selection gates. */
export async function findWorkContinuation(
	ctx: Pick<WorkContext, "cwd">,
	text: string,
	captured?: WorkScopeSnapshot,
): Promise<WorkContinuation | undefined> {
	const scope = captured ?? (await captureWorkScope(ctx.cwd))
	if (!scope?.isCurrent()) return
	const pasted = await pastedPlans(userText(text))
	if (!pasted || pasted.remaining.includes("<!-- kimchi-work-id:")) return
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
	if (named.some((file) => !file)) return // Unreadable evidence is not proof that a file has no owner.
	const matches = [...pasted.matches, ...named.flatMap((file) => (file?.match ? [file.match] : []))]
	if (new Set(matches.map((match) => match.workId)).size !== 1) return
	const match = matches[0]
	if (named.some((file) => file?.owners.some((owner) => owner !== match.workId))) return
	const owner = readWorkScope(match.workId)
	if (!owner || !sameWorkScope(owner, scope.scope) || !scope.isCurrent()) return
	const current = await captureWorkScope(ctx.cwd)
	if (current && sameWorkScope(current.scope, scope.scope) && scope.isCurrent()) return match
}
