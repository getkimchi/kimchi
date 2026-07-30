/**
 * Two things this workflow runs itself rather than asking an agent to run: a step's verification
 * command, and the diff its phase grader is shown.
 *
 * Running a step's verification command, as kimchi's `verify_ferment_step` does.
 *
 * kimchi executes the command through the harness's own `bash` tool with a 60s timeout and records
 * `{exitCode, stdout, stderr}` on the step. There is no tool loop here, so this runs it directly — same
 * shell, same timeout, same recorded shape. It is a FUNCTION step's body, deliberately: the command is
 * the plan's own, and handing it to an agent to run would let the agent decide what it saw.
 */
import { spawn } from "node:child_process"
import type { VerifyResult } from "./contract.ts"

/** kimchi's `VERIFY_TIMEOUT_MS`. */
export const VERIFY_TIMEOUT_MS = 60_000

const MAX_CAPTURE = 64_000

/**
 * What a diff command may return before this function starts dropping bytes of its own.
 *
 * It has to be well above the diff caps below, or the CAPTURE becomes the truncator: a diff over 64KB
 * would arrive already cut at the head, `capBytes` would keep the "tail" of the cut, and the reader would
 * be told a byte count that was not the real one. The evidence says how much it dropped, so it must be
 * the thing that dropped it.
 */
const MAX_DIFF_CAPTURE = 2_000_000

export async function runVerification(
	command: string,
	signal: AbortSignal,
	maxCapture = MAX_CAPTURE,
): Promise<VerifyResult> {
	return new Promise<VerifyResult>((resolve) => {
		let stdout = ""
		let stderr = ""
		let settled = false

		const finish = (exitCode: number, extraStderr = ""): void => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			signal.removeEventListener("abort", onAbort)
			resolve({
				ran: true,
				command,
				exitCode,
				stdout: stdout.slice(0, maxCapture),
				stderr: `${stderr}${extraStderr}`.slice(0, maxCapture),
			})
		}

		// `bash -lc` so the command sees a login shell's PATH — the same assumption every verify command in
		// a terminal-bench container is written against.
		const child = spawn("bash", ["-lc", command], { stdio: ["ignore", "pipe", "pipe"] })
		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdout.length < maxCapture) stdout += chunk.toString()
		})
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < maxCapture) stderr += chunk.toString()
		})

		const kill = (): void => {
			child.kill("SIGKILL")
		}
		const timer = setTimeout(() => {
			kill()
			finish(1, "\nVerification command timed out after 60s")
		}, VERIFY_TIMEOUT_MS)
		const onAbort = (): void => {
			kill()
			finish(1, "\nVerification command was cancelled")
		}
		signal.addEventListener("abort", onAbort, { once: true })

		child.on("error", (error: Error) => finish(1, `\nbash execution threw an exception: ${error.message}`))
		child.on("close", (code: number | null) => finish(code ?? 1))
	})
}

// -- Diff evidence ------------------------------------------------------------------------------------
//
// kimchi captures a git ref at `activate_ferment_phase` (`setPhaseStartRef`) and turns the range into
// evidence at `complete_ferment_phase` (`phase-evidence.ts`), so the phase grader sees what actually
// changed instead of only what the agent says changed. Same idea, same caps.
//
// ONE range, the phase's, and that is kimchi's line too. A version of this file also gathered a
// step-scope diff and pasted it into the step's gate turn, because that turn was a cold reviewer that had
// not seen the work and went and re-derived it — 92.4 min of gate turns over one 6-task run, against
// 23 min if each had cost its own task's fastest. The reviewer is gone: the step turn now DOES the work,
// so it holds the edits it made, and what it is handed instead is the one thing kimchi hands its
// orchestrator — the step's start ref. kimchi keeps `stepStartRefs` "(phaseId:stepId → sha) captured at
// start_ferment_step, consumed at complete_ferment_step for diff evidence" (runtime-state-store.ts:11)
// and surfaces the SHA in derived state (derive-state.ts:150). It never assembles a step diff for anyone.
//
// Untracked files ARE part of the phase evidence, and this port had dropped them. kimchi lists them
// (`git ls-files --others --exclude-standard`) and synthesises a diff against /dev/null for each, so a
// step that CREATED a file shows up as work. Without it F2's "cite the specific artifact" and the
// grader's independent check both read a phase of new files as a phase that changed nothing — handing a
// reader a diff that omits new files is worse than handing it none.

/** kimchi's `MAX_FILES_LISTED` (src/extensions/ferment/phase-evidence.ts). */
const MAX_FILES_LISTED = 20

/** kimchi's `MAX_DIFF_BYTES`: what the phase grader is shown. */
const MAX_PHASE_DIFF_BYTES = 4000

/** How many untracked files are diffed into the evidence — bounds the spawns, not just the bytes. */
const MAX_UNTRACKED_DIFFED = 20

export interface DiffEvidence {
	available: boolean
	filesChanged: string
	diffSnippet: string
	/**
	 * Bytes dropped from the middle of `diffSnippet`, 0 when it is whole.
	 *
	 * Carried as a number rather than left implicit in the snippet's own marker because the reader has to
	 * be TOLD it is reading a truncation: a grader that reads "not in the diff" as "not done" turns a byte
	 * cap into a refusal, and the prompt says so explicitly when this is non-zero.
	 */
	elidedBytes: number
}

const NO_DIFF: DiffEvidence = { available: false, filesChanged: "", diffSnippet: "", elidedBytes: 0 }

/** The commit a phase or step starts from, or `""` outside a git repo — evidence is best-effort, never fatal. */
export async function currentGitRef(signal: AbortSignal): Promise<string> {
	const result = await runVerification("git rev-parse HEAD", signal)
	return result.exitCode === 0 ? result.stdout.trim() : ""
}

/** What changed since `sinceRef`, as the phase grader is shown it. */
export async function phaseDiffSince(sinceRef: string, signal: AbortSignal): Promise<DiffEvidence> {
	return diffSince(sinceRef, signal, MAX_PHASE_DIFF_BYTES)
}

async function diffSince(sinceRef: string, signal: AbortSignal, maxDiffBytes: number): Promise<DiffEvidence> {
	if (!sinceRef) return NO_DIFF

	const stat = await runVerification(`git diff --stat ${sinceRef}`, signal, MAX_DIFF_CAPTURE)
	if (stat.exitCode !== 0) return NO_DIFF

	const untracked = await untrackedFiles(signal)
	const tracked = await runVerification(`git diff --unified=2 ${sinceRef}`, signal, MAX_DIFF_CAPTURE)

	// kimchi's ordering: tracked changes first, then the synthetic untracked diffs, bounded so a directory
	// full of new files cannot crowd out the edits the grader is actually ruling on.
	const parts: string[] = []
	if (tracked.exitCode === 0 && tracked.stdout.trim().length > 0) parts.push(tracked.stdout)
	let untrackedBytes = 0
	for (const file of untracked.slice(0, MAX_UNTRACKED_DIFFED)) {
		if (untrackedBytes >= maxDiffBytes) break
		const synthetic = await diffUntrackedFile(file, signal)
		if (synthetic.length === 0) continue
		parts.push(synthetic)
		untrackedBytes += synthetic.length
	}

	const capped = capBytes(parts.join("\n"), maxDiffBytes)
	return {
		available: true,
		filesChanged: fileList(stat.stdout.trim(), untracked) || "(no changes)",
		diffSnippet: capped.diffSnippet,
		elidedBytes: capped.elidedBytes,
	}
}

/**
 * The files git knows nothing about yet — kimchi's `gatherUntrackedFiles`, `--exclude-standard` and all,
 * so a .gitignore'd build directory stays out of the evidence.
 */
async function untrackedFiles(signal: AbortSignal): Promise<string[]> {
	const result = await runVerification("git ls-files --others --exclude-standard", signal, MAX_DIFF_CAPTURE)
	if (result.exitCode !== 0) return []
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
}

/**
 * A new file as a diff against /dev/null, so its content reads as added lines — kimchi's
 * `diffUntrackedFile`. `git diff --no-index` exits 1 when it finds differences, which is the expected
 * case here, so anything up to exit 1 is a usable answer.
 */
async function diffUntrackedFile(file: string, signal: AbortSignal): Promise<string> {
	const result = await runVerification(
		`git diff --no-index --unified=2 /dev/null ${shellQuote(file)}`,
		signal,
		MAX_DIFF_CAPTURE,
	)
	return result.exitCode <= 1 ? result.stdout : ""
}

/** A path goes through `bash -lc`, so it is quoted rather than trusted — kimchi avoids this with an argv spawn. */
function shellQuote(path: string): string {
	return `'${path.replaceAll("'", `'\\''`)}'`
}

/** The `--stat` block plus kimchi's `?? path` lines for untracked files, each capped on its own. */
function fileList(stat: string, untracked: readonly string[]): string {
	const tracked = stat.length > 0 ? capLines(stat) : ""
	if (untracked.length === 0) return tracked
	const listed = untracked.slice(0, MAX_FILES_LISTED).map((file) => `?? ${file}`)
	const rest =
		untracked.length > MAX_FILES_LISTED ? `\n[... ${untracked.length - MAX_FILES_LISTED} more untracked files ...]` : ""
	const block = `${listed.join("\n")}${rest}`
	return tracked ? `${tracked}\n${block}` : block
}

function capLines(text: string): string {
	const lines = text.split("\n")
	if (lines.length <= MAX_FILES_LISTED + 1) return text
	return `${lines.slice(0, MAX_FILES_LISTED).join("\n")}\n[... ${lines.length - MAX_FILES_LISTED} more ...]`
}

/** kimchi keeps the head and the tail of an oversized diff, not just the head. */
function capBytes(diff: string, maxDiffBytes: number): { diffSnippet: string; elidedBytes: number } {
	if (diff.length <= maxDiffBytes) return { diffSnippet: diff, elidedBytes: 0 }
	const half = Math.floor(maxDiffBytes / 2)
	const elidedBytes = diff.length - maxDiffBytes
	return {
		diffSnippet: `${diff.slice(0, half)}\n\n[... diff truncated, ${elidedBytes} bytes elided ...]\n\n${diff.slice(-half)}`,
		elidedBytes,
	}
}
