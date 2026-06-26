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

import { execSync, spawnSync } from "node:child_process"

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
		const untracked = gatherUntrackedFiles(cwd)

		// No tracked changes AND no untracked files
		if (!stat.trim() && untracked.length === 0) {
			return { filesChanged: "(no changes)", diffSnippet: "", available: true }
		}

		// Build combined file list: tracked diff stat + untracked entries.
		// Untracked entries use the `?? path` prefix that mirrors
		// `git status --porcelain` so the judge LLM can recognise them as
		// "new untracked file". Tracked files are capped first, then untracked
		// entries get a separate budget so they cannot crowd out the tracked
		// changes the judge is meant to grade.
		let filesChanged = limitFileList(stat)
		if (untracked.length > 0) {
			const untrackedLines = untracked.map((f) => `?? ${f}`)
			const untrackedSection = limitUntrackedList(untrackedLines)
			filesChanged = filesChanged ? `${filesChanged}\n${untrackedSection}` : untrackedSection
		}

		// Build combined diff: tracked diff + synthetic diffs for untracked files.
		// Untracked diffs are bounded by MAX_DIFF_BYTES to prevent an explosion if
		// there are many large untracked files; the final truncateDiff then bounds
		// the combined total.
		let fullDiff = run(`git diff --unified=2 ${sinceRef}`, cwd)
		if (untracked.length > 0) {
			const untrackedDiffs: string[] = []
			let untrackedBytes = 0
			for (const f of untracked) {
				if (untrackedBytes >= MAX_DIFF_BYTES) break
				const d = diffUntrackedFile(cwd, f)
				if (d) {
					untrackedDiffs.push(d)
					untrackedBytes += d.length
				}
			}
			if (untrackedDiffs.length > 0) {
				fullDiff = fullDiff ? `${fullDiff}\n${untrackedDiffs.join("\n")}` : untrackedDiffs.join("\n")
			}
		}

		const diffSnippet = truncateDiff(fullDiff)

		return { filesChanged, diffSnippet, available: true }
	} catch {
		return { filesChanged: "(git unavailable)", diffSnippet: "", available: false }
	}
}

/**
 * List untracked files on disk using `git ls-files --others --exclude-standard`.
 * This respects .gitignore (unlike `--others` alone), so gitignored files are
 * excluded. Returns relative paths, one per line. Empty array on git error —
 * intentionally swallows errors to match the best-effort pattern of the rest
 * of this module (the outer gatherPhaseEvidence try/catch is the safety net).
 */
function gatherUntrackedFiles(cwd: string): string[] {
	try {
		const output = run("git ls-files --others --exclude-standard", cwd)
		return output
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
	} catch {
		return []
	}
}

/**
 * Produce a synthetic unified diff for an untracked file by diffing it against
 * /dev/null. Git treats /dev/null as an empty file across all platforms, so
 * the entire file content appears as `+`-prefixed added lines.
 *
 * Uses spawnSync with an argument array (shell: false) to avoid command
 * injection via file names containing shell metacharacters.
 *
 * `git diff --no-index` exits with code 1 when differences are found (which
 * is the expected case here) and code 0 when files are identical. We read
 * result.stdout regardless of exit code. Returns "" on any other error
 * (e.g. file deleted between listing and diffing).
 */
function diffUntrackedFile(cwd: string, filePath: string): string {
	const result = spawnSync("git", ["diff", "--no-index", "--unified=2", "/dev/null", filePath], {
		cwd,
		encoding: "utf-8",
		timeout: GIT_TIMEOUT_MS,
		shell: false,
		stdio: ["ignore", "pipe", "ignore"],
	})
	// Exit code 1 = differences found (expected). Exit code 0 = identical.
	// Any other code or signal failure = error, return empty.
	if (result.status !== null && result.status <= 1) {
		return result.stdout ?? ""
	}
	return ""
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

/**
 * Cap untracked file entries independently so they never evict tracked
 * changes from the evidence. Allows up to MAX_FILES_LISTED untracked entries
 * before summarising the remainder.
 */
function limitUntrackedList(lines: string[]): string {
	if (lines.length <= MAX_FILES_LISTED) return lines.join("\n")
	const head = lines.slice(0, MAX_FILES_LISTED).join("\n")
	return `${head}\n[... ${lines.length - MAX_FILES_LISTED} more untracked files ...]`
}

function truncateDiff(diff: string): string {
	if (diff.length <= MAX_DIFF_BYTES) return diff
	const half = Math.floor(MAX_DIFF_BYTES / 2)
	const head = diff.slice(0, half)
	const tail = diff.slice(-half)
	return `${head}\n\n[... diff truncated, ${diff.length - MAX_DIFF_BYTES} bytes elided ...]\n\n${tail}`
}
