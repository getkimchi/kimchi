import { mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { lock } from "proper-lockfile"
import { isWorkId } from "../../shared/work-id.js"
import { currentBranch } from "../pull-request-status/branch-status.js"
import { appendJournalLine, object, truncated } from "./summary.js"

/*
 * The Jira issue chosen for a work with `/work issue`. Each selection or clear appends a revision to
 * `work/<workId>/issue.jsonl`, written and read like the session journals; the newest revision is current and earlier
 * ones stay as history. It is separate from the work's immutable `scope.json`. It is not a journal record: a selection
 * belongs to a work and is read before every input, while journals are per session, and an older Kimchi's PR cost
 * reporting stops on journal record types it does not know. Request rows copy the selection their input began with.
 */

/** An uppercase project key of at least two characters, a dash and an issue number, within the lengths the backend accepts in titles. */
const ISSUE_KEY = /^[A-Z][A-Z0-9_]{1,254}-[1-9][0-9]{0,15}$/
/** Key-shaped tokens; a letter, digit or underscore on either side makes one part of a longer word. */
const BRANCH_ISSUE_KEYS = /(?<![A-Za-z0-9_])[A-Z][A-Z0-9_]{1,254}-[1-9][0-9]{0,15}(?![A-Za-z0-9_])/g
/** The lock timing of work summaries; a writer holds this lock only to read the file and append one line. */
const LOCK_STALE_MS = 5000
const LOCK_RETRIES = { retries: 60, factor: 1.5, minTimeout: 25, maxTimeout: 100 }
const BRANCH_TIMEOUT_MS = 2000
const CHOOSE = "Choose with: /work issue <KEY> or /work issue clear"

/** One line of `issue.jsonl`. */
interface WorkIssueRevision {
	version: 1
	workId: string
	revision: number
	status: "selected" | "cleared"
	/** Set exactly when the revision selects an issue. */
	issueKey?: string
	source: "work-command"
	sessionId: string
	recordedAt: string
}

/** The issue a request was sent for: its work's selection when the request's input began. */
export interface WorkIssueBinding {
	key: string
	revision: number
}

/** A work's issue, folded from its revisions. */
export interface WorkIssue {
	/** The newest revision number; 0 before the first. */
	revision: number
	/** Set when the newest revision selects an issue. */
	selected?: WorkIssueBinding
	/** Disagreeing newest revisions, saved by writers that missed each other; null stands for a clear. */
	conflicting?: (string | null)[]
	/** `path:line` of an unreadable line after the newest readable revision: the selection is unknown until the next. */
	unreadable?: string
}

/** The key `text` names, with ASCII letters uppercased, or undefined when it is not exactly one Jira key. */
export function parseIssueKey(text: string): string | undefined {
	const key = text.replace(/[a-z]/g, (letter) => letter.toUpperCase())
	return ISSUE_KEY.test(key) ? key : undefined
}

/** The distinct Jira-key-shaped tokens of a branch name, in order. */
export function branchIssueKeys(branch: string): string[] {
	return [...new Set(branch.match(BRANCH_ISSUE_KEYS))]
}

export function workIssuePath(agentDir: string, workId: string): string {
	if (!isWorkId(workId)) throw new Error("Invalid work UUID")
	return join(agentDir, "work", workId, "issue.jsonl")
}

/** A saved revision's number and issue (null for a clear), or undefined for a line this version cannot read. */
function readRevision(value: unknown, workId: string): { revision: number; key: string | null } | undefined {
	if (!object(value) || value.version !== 1 || value.workId !== workId) return
	const { revision, status, issueKey, source, sessionId, recordedAt } = value
	if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) return
	if (typeof source !== "string" || typeof sessionId !== "string" || typeof recordedAt !== "string") return
	if (status === "cleared" && issueKey === undefined) return { revision, key: null }
	if (status === "selected" && typeof issueKey === "string" && ISSUE_KEY.test(issueKey))
		return { revision, key: issueKey }
}

/** The work's issue. A missing file is a work without one; reading never throws. */
export function readWorkIssue(agentDir: string, workId: string): WorkIssue {
	if (!isWorkId(workId)) return { revision: 0 }
	const path = workIssuePath(agentDir, workId)
	let text: string
	try {
		text = readFileSync(path, "utf8")
	} catch (error) {
		return object(error) && error.code === "ENOENT" ? { revision: 0 } : { revision: 0, unreadable: path }
	}
	const lines = text.split("\n")
	const revisions: { revision: number; key: string | null }[] = []
	// Line numbers of the newest readable revision and of the newest damage.
	let readable = 0
	let damaged = 0
	// Cut-off records that no later line has followed yet.
	let cut: number[] = []
	for (const [index, line] of lines.entries()) {
		if (!line.trim()) continue
		// A later line shows that the cut-off records before it were interrupted appends.
		cut = []
		let value: unknown
		try {
			value = JSON.parse(line)
		} catch {
			// Text after the last line break may still be being written.
			if (index === lines.length - 1) continue
			if (truncated(line)) cut.push(index + 1)
			else damaged = index + 1
			continue
		}
		const revision = readRevision(value, workId)
		if (revision) {
			revisions.push(revision)
			readable = index + 1
		} else damaged = index + 1
	}
	// A cut-off record that nothing followed may have been the newest revision.
	damaged = Math.max(damaged, ...cut)
	const newest = revisions.reduce((highest, row) => Math.max(highest, row.revision), 0)
	// A revision saved after damage was chosen with the damage in view, so it decides.
	if (damaged > readable) return { revision: newest, unreadable: `${path}:${damaged}` }
	const keys = [...new Set(revisions.filter((row) => row.revision === newest).map((row) => row.key))]
	if (keys.length > 1) return { revision: newest, conflicting: keys }
	return keys[0] ? { revision: newest, selected: { key: keys[0], revision: newest } } : { revision: newest }
}

/**
 * Saves `issueKey`, or a clear when it is undefined, as the work's next revision unless it is already current.
 * Writers hold the work's issue lock while they read and append, so simultaneous sessions get consecutive revisions.
 * Two revisions with one number, which only a lost lock can produce, read as unsettled until the next change.
 */
export async function changeWorkIssue(
	agentDir: string,
	workId: string,
	sessionId: string,
	issueKey: string | undefined,
): Promise<{ previous: WorkIssue; current: WorkIssue; changed: boolean }> {
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
	try {
		const previous = readWorkIssue(agentDir, workId)
		if (!previous.conflicting && !previous.unreadable && previous.selected?.key === issueKey)
			return { previous, current: previous, changed: false }
		if (compromised) throw compromised
		const record: WorkIssueRevision = {
			version: 1,
			workId,
			revision: previous.revision + 1,
			status: issueKey ? "selected" : "cleared",
			...(issueKey ? { issueKey } : {}),
			source: "work-command",
			sessionId,
			recordedAt: new Date().toISOString(),
		}
		appendJournalLine(path, record)
		return { previous, current: readWorkIssue(agentDir, workId), changed: true }
	} finally {
		// A compromised lease has already been removed from proper-lockfile's ownership map.
		if (!compromised) await release()
	}
}

/** "a", "a and b", "a, b and c". */
function list(items: string[]): string {
	return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items.join("")
}

/** What `/work` prints about a work's issue; nothing for a work without one. */
export function workIssueLines(issue: WorkIssue): string[] {
	if (issue.unreadable) return [`Jira issue: unknown; ${issue.unreadable} is unreadable. ${CHOOSE}`]
	if (issue.conflicting)
		return [
			`Jira issue: unsettled; simultaneous changes chose ${list(issue.conflicting.map((key) => key ?? "no issue"))}. ${CHOOSE}`,
		]
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
