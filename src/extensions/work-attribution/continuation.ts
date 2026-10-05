import { execFile } from "node:child_process"
import { readFile, realpath } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"
import { parseSkillBlock } from "@earendil-works/pi-coding-agent"
import { readPlanWorkId } from "../../shared/planning/plan-markdown.js"
import type { WorkContext } from "../work-attribution.js"
import { type FileTransition, readAttributedFileState, readRepositoryTransitions } from "./file-transitions.js"

const RECENT_WORK_MS = 24 * 60 * 60 * 1000
const MARKDOWN_REFERENCE = /(?:^|[\s@'"`([])([^\s@'"`()[\]<>#]+\.md)(?:#[^\s'"`()[\]<>]*)?(?=$|[\s'"`()[\],;:.!?])/gi
const NATIVE_PLAN_PATH = /\/(?:\.kimchi\/plans|work\/[\da-f-]{36}\/plans)\/[^/]+\.md$/i

export interface WorkContinuation {
	workId: string
	source: "saved-plan" | "named-artifact" | "recent-branch"
	evidence: {
		path: string
		transitionId?: string
		repository?: string
		worktree?: string
		branch?: string
		recordedAt?: string
	}
}
function artifactMatch(row: FileTransition, path: string, source: WorkContinuation["source"]): WorkContinuation {
	return {
		workId: row.workId,
		source,
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
async function namedArtifact(cwd: string, named: string): Promise<WorkContinuation | undefined> {
	const resolved = resolve(cwd, named)
	let path: string
	try {
		// Resolve the directory only: native attribution deliberately rejects symlink files.
		path = join(await realpath(dirname(resolved)), basename(resolved))
		if (NATIVE_PLAN_PATH.test(path)) {
			const workId = readPlanWorkId(await readFile(path, "utf8"))
			if (workId) return { workId, source: "saved-plan", evidence: { path } }
		}
	} catch {
		return
	}
	const evidence = await readRepositoryTransitions(dirname(path))
	if (!evidence) return
	const rows = evidence.transitions.filter(
		(row) => row.repository === evidence.repository && row.path === relative(evidence.worktree, path),
	)
	if (new Set(rows.map((row) => row.workId)).size !== 1) return
	const row = latest(rows)
	if (row && (await unchanged(row, path))) return artifactMatch(row, path, "named-artifact")
}
async function defaultBranches(cwd: string): Promise<Set<string>> {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[key]
	return new Promise((resolve) => {
		execFile(
			"git",
			["-C", cwd, "for-each-ref", "--format=%(symref)", "refs/remotes"],
			{ encoding: "utf8", timeout: 2000, env },
			(error, stdout) =>
				resolve(new Set(error ? [] : [...stdout.matchAll(/^refs\/remotes\/[^/]+\/(.+)$/gm)].map((match) => match[1]))),
		)
	})
}

/** Resolve identity before dispatch; the caller owns fresh-session and explicit-selection gates. */
export async function findWorkContinuation(
	ctx: Pick<WorkContext, "cwd">,
	text: string,
	options: { allowBranchFallback?: boolean } = {},
): Promise<WorkContinuation | undefined> {
	// RPC clients can pass an already expanded skill. Only its user arguments select work.
	const skill = parseSkillBlock(text)
	const userText = skill ? (skill.userMessage ?? "") : text
	const paths = [...new Set([...userText.matchAll(MARKDOWN_REFERENCE)].map((match) => match[1]))]
	if (paths.length) {
		const matches = await Promise.all(paths.map((path) => namedArtifact(ctx.cwd, path)))
		if (matches.some((match) => !match) || new Set(matches.map((match) => match?.workId)).size !== 1) return
		return matches[0]
	}
	if (!options.allowBranchFallback) return
	const evidence = await readRepositoryTransitions(ctx.cwd)
	if (!evidence?.branch) return
	const defaults = await defaultBranches(evidence.worktree)
	if (!defaults.size || defaults.has(evidence.branch)) return
	const now = Date.now()
	const recent = evidence.transitions.filter(
		(row) =>
			row.repository === evidence.repository &&
			row.worktree === evidence.worktree &&
			row.branch === evidence.branch &&
			recordedTime(row) <= now &&
			now - recordedTime(row) <= RECENT_WORK_MS,
	)
	if (new Set(recent.map((row) => row.workId)).size !== 1) return
	const row = latest(recent.filter((row) => row.path.toLowerCase().endsWith(".md")))
	if (!row) return
	const owners = evidence.transitions.filter((entry) => entry.path === row.path).map((entry) => entry.workId)
	if (new Set(owners).size !== 1) return
	// A branch match is a heuristic, kept visible in the saved continuation evidence.
	const path = join(evidence.worktree, row.path)
	if (await unchanged(row, path)) return artifactMatch(row, path, "recent-branch")
}
