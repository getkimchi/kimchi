import { mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { lock } from "proper-lockfile"
import { writeFileDurably } from "../../config/json.js"
import { branchIssueKeys, isIssueKey } from "../../shared/issue-keys.js"
import { isWorkId } from "../../shared/work-id.js"
import { currentBranch } from "../pull-request-status/branch-status.js"
import { LOCK_RETRIES, LOCK_STALE_MS, object } from "./summary.js"

/*
 * The Jira issue chosen for a work with `/work issue`, in `work/<workId>/issue.json`. Writers hold the file's lock while
 * they read and replace it, as the work summary's writers do, so simultaneous sessions get consecutive revisions. It is
 * separate from the work's immutable `scope.json`. It is not a journal record: a selection belongs to a work and is read
 * before every input, while journals are per session, and an older Kimchi's PR cost reporting stops on journal record
 * types it does not know. Request rows copy the selection their input began with.
 */

const BRANCH_TIMEOUT_MS = 2000
const CHOOSE = "Choose with: /work issue <KEY> or /work issue clear"

/** `issue.json`: the work's selection, or the clear that ended it. */
interface SavedWorkIssue {
	version: 1
	workId: string
	revision: number
	/** Set while the work has an issue; a clear saves the next revision without one. */
	issueKey?: string
	sessionId: string
	recordedAt: string
}

/** The issue a request was sent for: its work's selection when the request's input began. */
export interface WorkIssueBinding {
	key: string
	revision: number
}

/** A work's issue. */
export interface WorkIssue {
	/** The saved revision number; 0 before the first. */
	revision: number
	/** Set when the saved revision selects an issue. */
	selected?: WorkIssueBinding
	/** The path of a file this version cannot read: the selection is unknown until the next change. */
	unreadable?: string
}

/** The key `text` names, with ASCII letters uppercased, or undefined when it is not exactly one Jira key. */
export function parseIssueKey(text: string): string | undefined {
	// Only ASCII letters: toUpperCase would also turn ı and ſ into I and S.
	const key = Array.from(text, (character) =>
		character >= "a" && character <= "z" ? character.toUpperCase() : character,
	).join("")
	return isIssueKey(key) ? key : undefined
}

export function workIssuePath(agentDir: string, workId: string): string {
	if (!isWorkId(workId)) throw new Error("Invalid work UUID")
	return join(agentDir, "work", workId, "issue.json")
}

/** The work's issue. A missing file is a work without one; reading never throws. */
export function readWorkIssue(agentDir: string, workId: string): WorkIssue {
	if (!isWorkId(workId)) return { revision: 0 }
	const path = workIssuePath(agentDir, workId)
	let value: unknown
	try {
		value = JSON.parse(readFileSync(path, "utf8"))
	} catch (error) {
		return object(error) && error.code === "ENOENT" ? { revision: 0 } : { revision: 0, unreadable: path }
	}
	if (!object(value) || value.version !== 1 || value.workId !== workId) return { revision: 0, unreadable: path }
	const { revision, issueKey } = value
	if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1)
		return { revision: 0, unreadable: path }
	if (issueKey === undefined) return { revision }
	return typeof issueKey === "string" && isIssueKey(issueKey)
		? { revision, selected: { key: issueKey, revision } }
		: { revision, unreadable: path }
}

/**
 * Saves `issueKey`, or a clear when it is undefined, as the work's next revision unless it is already current. Writers
 * hold the file's lock while they read and replace it, so simultaneous sessions get consecutive revisions; a writer
 * whose lock was taken over saves nothing.
 */
export async function changeWorkIssue(
	agentDir: string,
	workId: string,
	sessionId: string,
	issueKey: string | undefined,
): Promise<{ previous: WorkIssue; changed: boolean }> {
	const path = workIssuePath(agentDir, workId)
	// The lock is a directory beside the file.
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	let compromised: Error | undefined
	const release = await lock(path, {
		realpath: false,
		stale: LOCK_STALE_MS,
		retries: LOCK_RETRIES,
		onCompromised: (error) => {
			compromised = error
		},
	})
	const assertLease = () => {
		if (compromised) throw compromised
	}
	try {
		const previous = readWorkIssue(agentDir, workId)
		if (!previous.unreadable && previous.selected?.key === issueKey) return { previous, changed: false }
		const saved: SavedWorkIssue = {
			version: 1,
			workId,
			revision: previous.revision + 1,
			...(issueKey ? { issueKey } : {}),
			sessionId,
			recordedAt: new Date().toISOString(),
		}
		await writeFileDurably(path, `${JSON.stringify(saved)}\n`, assertLease)
		return { previous, changed: true }
	} finally {
		// A compromised lease has already been removed from proper-lockfile's ownership map.
		if (!compromised) await release()
	}
}

/** What `/work` prints about a work's issue; nothing for a work without one. */
export function workIssueLines(issue: WorkIssue): string[] {
	if (issue.unreadable) return [`Jira issue: unknown; ${issue.unreadable} is unreadable. ${CHOOSE}`]
	return issue.selected ? [`Jira issue: ${issue.selected.key}`] : []
}

/** Suggests a key the checked-out branch names, unless it is the selected one. Only the command selects. */
async function branchSuggestion(cwd: string, selected: string | undefined): Promise<string[]> {
	let branch: string | undefined
	try {
		branch = await currentBranch(cwd, AbortSignal.timeout(BRANCH_TIMEOUT_MS), Date.now() + BRANCH_TIMEOUT_MS)
	} catch {
		return []
	}
	// A detached HEAD or a folder outside Git has no branch.
	const keys = branch ? branchIssueKeys(branch) : []
	if (keys.length > 1)
		return [`Branch ${branch} names several issues: ${keys.join(", ")}. Select one with: /work issue <KEY>`]
	if (keys.length === 1 && keys[0] !== selected)
		return [`Branch ${branch} names ${keys[0]}. Select it with: /work issue ${keys[0]}`]
	return []
}

/**
 * `/work issue [<KEY>|clear]` for the current work: what it says before the work's details, which name the issue,
 * and whether it saved a revision.
 */
export async function workIssueCommand(
	work: { agentDir: string; workId: string; sessionId: string; cwd: string },
	args: string,
): Promise<{ lines: string[]; changed: boolean; warning?: true }> {
	const value = args.trim()
	if (!value) {
		const issue = readWorkIssue(work.agentDir, work.workId)
		const suggestion = await branchSuggestion(work.cwd, issue.selected?.key)
		if (workIssueLines(issue).length) return { lines: suggestion, changed: false }
		return {
			lines: suggestion.length
				? ["Jira issue: none", ...suggestion]
				: ["Jira issue: none. Select one with: /work issue <KEY>"],
			changed: false,
		}
	}
	const key = value === "clear" ? undefined : parseIssueKey(value)
	if (!key && value !== "clear")
		return {
			lines: [
				`Not a Jira issue key: ${JSON.stringify(value.slice(0, 80))}. Use /work issue <KEY>, such as /work issue ABC-123, or /work issue clear.`,
			],
			changed: false,
			warning: true,
		}
	const { previous, changed } = await changeWorkIssue(work.agentDir, work.workId, work.sessionId, key)
	const replaced = previous.selected?.key
	if (key)
		return {
			lines: [
				changed
					? `Jira issue ${key} selected for this work${replaced ? `, replacing ${replaced}` : ""}. It applies from the next prompt; earlier requests are unchanged.`
					: `Jira issue ${key} is already selected for this work.`,
			],
			changed,
		}
	return {
		lines: [
			changed
				? `Jira issue ${replaced ? `${replaced} ` : ""}cleared from this work. From the next prompt, requests have no issue; earlier requests are unchanged.`
				: "No Jira issue is selected for this work.",
		],
		changed,
	}
}
