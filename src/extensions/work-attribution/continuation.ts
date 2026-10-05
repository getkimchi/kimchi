import { readdir, readFile, realpath } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"
import { getAgentDir, parseSkillBlock } from "@earendil-works/pi-coding-agent"
import { readPlanWorkId } from "../../shared/planning/plan-markdown.js"
import type { WorkContext } from "../work-attribution.js"
import { type FileTransition, readAttributedFileState, readRepositoryTransitions } from "./file-transitions.js"
import { captureWorkScope, readWorkScope, sameWorkScope, type WorkAccount, type WorkScopeSnapshot } from "./scope.js"

const MARKDOWN_REFERENCE = /(?:^|[\s@'"`([])([^\s@'"`()[\]<>#]+\.md)(?:#[^\s'"`()[\]<>]*)?(?=$|[\s'"`()[\],;:.!?])/gi
const NATIVE_PLAN_PATH = /\/(?:\.kimchi\/plans|work\/[\da-f-]{36}\/plans)\/[^/]+\.md$/i

/** Unresolved explicit references must not be overridden by a semantic guess. */
export function hasWorkReference(text: string): boolean {
	const normalized = text.replaceAll("\r\n", "\n")
	const skill = parseSkillBlock(normalized)
	const message = skill ? (skill.userMessage ?? "") : normalized
	return message.includes("<!-- kimchi-work-id:") || [...message.matchAll(MARKDOWN_REFERENCE)].length > 0
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
	if (row && (await unchanged(row, path))) return artifactMatch(row, path)
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
	// RPC clients can pass an already expanded skill. Only its user arguments select work.
	const normalized = text.replaceAll("\r\n", "\n")
	const skill = parseSkillBlock(normalized)
	const userText = skill ? (skill.userMessage ?? "") : normalized
	const pasted = await pastedPlans(userText)
	if (!pasted) return
	const paths = [...new Set([...pasted.remaining.matchAll(MARKDOWN_REFERENCE)].map((match) => match[1]))]
	const matches = [...pasted.matches, ...(await Promise.all(paths.map((path) => namedArtifact(ctx.cwd, path))))]
	if (matches.some((match) => !match) || new Set(matches.map((match) => match?.workId)).size !== 1) return
	const match = matches[0]
	const owner = match && readWorkScope(match.workId)
	if (!owner || !sameWorkScope(owner, scope.scope) || !scope.isCurrent()) return
	const current = await captureWorkScope(ctx.cwd)
	if (current && sameWorkScope(current.scope, scope.scope) && scope.isCurrent()) return match
}
