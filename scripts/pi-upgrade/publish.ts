import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { type RunConfig, readJson, writeJson } from "./config.ts"
import { findIssue, gh, type IssueSnapshot, LABEL, loadState } from "./github.ts"
import type { AnalysisFile, Digest } from "./schemas.ts"
import type { SettleResult } from "./settle.ts"
import { inputsHash, parseState, type State, serializeState } from "./state.ts"

/** A full report older than this is regenerated even when nothing else changed. */
export const REFRESH_MS = 7 * 24 * 60 * 60 * 1000

export interface PublishInput {
	/** Latest `pi-upgrade` issue, open or closed. */
	issue: IssueSnapshot | null
	state: State
	settle: SettleResult
	report: string | null
	inputsHash: string
	now: Date
	forced: boolean
	/** Every step produced its result; only then is `lastRun` advanced (an incomplete run retries tomorrow). */
	complete: boolean
	/** One-line summaries of what the newly digested releases bring, for the "target moved" comment. */
	whatsNew: string[]
}

export type PublishAction =
	| { kind: "noop"; reason: string }
	| { kind: "create" | "update" | "reopen"; title: string; body: string; comment?: string; state: State }
	| { kind: "close"; comment: string; state: State }

export const issueTitle = (baseline: string, target: string) => `Pi upgrade ready: ${baseline} → ${target}`

/** True when a full (expensive) report is due for this target; false means the issue is current. */
export function needsReport(
	input: Pick<PublishInput, "issue" | "state" | "settle" | "inputsHash" | "now" | "forced">,
): boolean {
	const { issue, state, settle, now } = input
	if (input.forced) return true
	if (!settle.target) return false
	const last = state.lastRun
	if (issue?.state === "closed" && !state.closedByJob) return last?.target !== settle.target
	if (!issue || issue.state === "closed" || !last) return true
	return (
		last.target !== settle.target ||
		last.inputsHash !== input.inputsHash ||
		now.getTime() - Date.parse(last.at) >= REFRESH_MS
	)
}

/** Decides what to do with the rolling issue. Pure; `executePublish` carries it out. */
export function planPublish(input: PublishInput): PublishAction {
	const { issue, state, settle, report, now } = input
	if (input.forced) return { kind: "noop", reason: "forced run: job summary only" }

	if (!settle.target) {
		if (settle.behind.versions === 0 && issue?.state === "open") {
			return { kind: "close", comment: `Up to date at ${settle.baseline}.`, state: { ...state, closedByJob: true } }
		}
		return { kind: "noop", reason: settle.behind.versions === 0 ? "up to date" : "newest version still settling" }
	}
	if (!report) return { kind: "noop", reason: "no report" }
	if (!needsReport(input)) {
		return {
			kind: "noop",
			reason: issue?.state === "closed" ? "closed by a person: target skipped" : "issue is current",
		}
	}

	const previous = state.lastRun?.target
	const moved = previous !== undefined && previous !== settle.target
	const nextState: State = {
		...state,
		closedByJob: undefined,
		lastRun: input.complete
			? { baseline: settle.baseline, target: settle.target, inputsHash: input.inputsHash, at: now.toISOString() }
			: state.lastRun,
	}
	const fields = {
		title: issueTitle(settle.baseline, settle.target),
		body: report,
		comment: moved
			? [
					`Target moved ${previous} → ${settle.target} — new since last report:`,
					...input.whatsNew.map((w) => `- ${w}`),
				].join("\n")
			: undefined,
		state: nextState,
	}
	if (!issue || (issue.state === "closed" && state.closedByJob))
		return { kind: "create", ...fields, comment: undefined }
	return { kind: issue.state === "closed" ? "reopen" : "update", ...fields }
}

const STATE_COMMENT_PREFIX =
	"Pi upgrade trigger state — written by the job, do not edit. Delete it to force a full re-analysis.\n\n"

function upsertStateComment(issueNumber: number, commentId: number | undefined, state: State): void {
	const body = STATE_COMMENT_PREFIX + serializeState(state, 65_536 - STATE_COMMENT_PREFIX.length)
	if (commentId) {
		gh(["api", "-X", "PATCH", `repos/{owner}/{repo}/issues/comments/${commentId}`, "-F", "body=@-"], body)
	} else {
		gh(["issue", "comment", String(issueNumber), "--body-file", "-"], body)
	}
}

export function executePublish(action: PublishAction, issue: IssueSnapshot | null): string {
	switch (action.kind) {
		case "noop":
			return `no issue change (${action.reason})`
		case "create": {
			gh(["label", "create", LABEL, "--description", "Pi upgrade trigger", "--color", "5319e7", "--force"])
			const url = gh(
				["issue", "create", "--title", action.title, "--label", LABEL, "--body-file", "-"],
				action.body,
			).trim()
			const number = Number(url.split("/").pop())
			upsertStateComment(number, undefined, action.state)
			return `created ${url}`
		}
		case "update":
		case "reopen": {
			if (!issue) throw new Error(`${action.kind} without an issue`)
			if (action.kind === "reopen") gh(["issue", "reopen", String(issue.number)])
			gh(["issue", "edit", String(issue.number), "--title", action.title, "--body-file", "-"], action.body)
			if (action.comment) gh(["issue", "comment", String(issue.number), "--body-file", "-"], action.comment)
			upsertStateComment(issue.number, issue.stateCommentId, action.state)
			return `${action.kind === "reopen" ? "reopened" : "updated"} #${issue.number}`
		}
		case "close": {
			if (!issue) throw new Error("close without an issue")
			gh(["issue", "comment", String(issue.number), "--body-file", "-"], action.comment)
			upsertStateComment(issue.number, issue.stateCommentId, action.state)
			gh(["issue", "close", String(issue.number)])
			return `closed #${issue.number}`
		}
	}
}

function whatsNew(digests: Digest[]): string[] {
	return digests.flatMap((d) =>
		[...d.breaking, ...d.behaviorChanges, ...d.builtins, ...d.features].slice(0, 3).map((f) => `${d.to}: ${f.summary}`),
	)
}

function tryFindIssue(): IssueSnapshot | null {
	try {
		return findIssue()
	} catch {
		return null
	}
}

export async function runPublish(cfg: RunConfig): Promise<{ action: PublishAction["kind"]; result: string }> {
	const settle = readJson<SettleResult>(cfg, "settle")
	const reportPath = join(cfg.outDir, "report.md")
	const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : null
	if (report && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`)

	const issue = cfg.publish ? findIssue() : tryFindIssue()
	const baseState = cfg.stateFile
		? loadState(cfg.stateFile, (p) => readFileSync(p, "utf8"))
		: issue
			? parseState(issue.stateCommentBody)
			: parseState(undefined)
	const analysis = existsSync(join(cfg.outDir, "analysis.json")) ? readJson<AnalysisFile>(cfg, "analysis") : null
	const fresh = analysis && !("unavailable" in analysis) ? analysis.newDigests : []
	const state: State = {
		...baseState,
		digests: { ...baseState.digests, ...Object.fromEntries(fresh.map((d) => [`${d.from}..${d.to}`, d])) },
	}

	const action = planPublish({
		issue,
		state,
		settle,
		report,
		inputsHash: settle.target ? inputsHash(cfg.repoRoot, settle.baseline, settle.target) : "",
		now: cfg.now,
		forced: settle.forced,
		complete: existsSync(join(cfg.outDir, "tests.json")) && analysis !== null && !("unavailable" in analysis),
		whatsNew: whatsNew(fresh),
	})
	if (action.kind !== "noop") writeJson(cfg, "state", action.state)
	if (!cfg.publish) return { action: action.kind, result: `dry run (pass --publish to apply): would ${action.kind}` }
	return { action: action.kind, result: executePublish(action, issue) }
}
