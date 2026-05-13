/**
 * Phase evidence gatherer.
 *
 * The phase grader used to see only planner-written summaries — which let
 * "tests pass but the integration is wrong" failures slip through. This
 * module gathers concrete evidence of what was actually changed during a
 * phase by running git diff against the phase's start commit, then surfaces
 * a bounded summary the judge can compare against the planner's claims.
 *
 * We don't run an agent loop with tool access on the judge — that's a much
 * larger change. We do the gathering up front and inject the results into
 * the judge prompt as a single static block.
 */

import { execSync } from "node:child_process"

const MAX_FILES_LISTED = 20
const MAX_DIFF_BYTES = 4000
const GIT_TIMEOUT_MS = 5000

export interface PhaseEvidence {
	/** Files touched between the phase start and now, with insertion/deletion counts. */
	filesChanged: string
	/** Truncated unified diff (head + tail) summarising the actual edits. */
	diffSnippet: string
	/** True when git was reachable AND produced data. False on errors / not-a-repo. */
	available: boolean
}

/**
 * Collect changes since `sinceRef` (typically the phase's startedAt-anchored
 * commit, or HEAD~N as a fallback). Returns a structured evidence object
 * suitable for embedding in a judge prompt.
 */
export function gatherPhaseEvidence(sinceRef = "HEAD~10", cwd = process.cwd()): PhaseEvidence {
	try {
		const stat = run(`git diff --stat ${sinceRef}`, cwd)
		if (!stat.trim()) {
			return { filesChanged: "(no changes)", diffSnippet: "", available: true }
		}

		const filesChanged = limitFileList(stat)

		// Bound the diff. We include a head + tail of the unified diff so the
		// judge sees both the first and the last changes in case the diff is
		// long. Plain `git diff` without context limits could explode in size.
		const fullDiff = run(`git diff --unified=2 ${sinceRef}`, cwd)
		const diffSnippet = truncateDiff(fullDiff)

		return { filesChanged, diffSnippet, available: true }
	} catch {
		return { filesChanged: "(git unavailable)", diffSnippet: "", available: false }
	}
}

/** Capture git HEAD as a SHA. Best-effort; returns undefined on non-git or git failure. */
export function captureGitHead(cwd: string = process.cwd()): string | undefined {
	try {
		return run("git rev-parse HEAD", cwd).trim()
	} catch {
		return undefined
	}
}

function run(cmd: string, cwd: string): string {
	return execSync(cmd, {
		cwd,
		encoding: "utf-8",
		timeout: GIT_TIMEOUT_MS,
		stdio: ["ignore", "pipe", "ignore"],
	}).toString()
}

function limitFileList(stat: string): string {
	const lines = stat.split("\n").filter(Boolean)
	if (lines.length <= MAX_FILES_LISTED + 1) return stat.trim()
	const head = lines.slice(0, MAX_FILES_LISTED).join("\n")
	const remaining = lines.length - MAX_FILES_LISTED
	const tail = lines[lines.length - 1]
	return `${head}\n[... ${remaining} more files ...]\n${tail}`
}

function truncateDiff(diff: string): string {
	if (diff.length <= MAX_DIFF_BYTES) return diff
	const half = Math.floor(MAX_DIFF_BYTES / 2)
	const head = diff.slice(0, half)
	const tail = diff.slice(-half)
	return `${head}\n\n[... diff truncated, ${diff.length - MAX_DIFF_BYTES} bytes elided ...]\n\n${tail}`
}
