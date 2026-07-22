import { createHash } from "node:crypto"
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "./agent-worker-context.js"
import type {
	LoopGuardDetector,
	LoopGuardEventChannel,
	LoopGuardSubagentAbortPayload,
	LoopGuardWarnPayload,
} from "./loop-guard-events.js"
import { LOOP_GUARD_EVENTS } from "./loop-guard-events.js"

export interface ToolHistoryRecord {
	toolName: string
	toolArgs: string
	isError: boolean
	outputFingerprint: string
}

export type LoopGuardState = "ok" | "warn" | "terminate"

export interface LoopGuardResult {
	state: LoopGuardState
	reason?: string
	/** Which detector fired. Set on the 'warn' path; undefined otherwise. */
	detector?: LoopGuardDetector
}

// Detection thresholds. Exact detectors (which require matching output) can
// fire sooner because a true output match is strong evidence of a loop;
// fuzzy detectors (name+args only) are deliberately laxer to avoid flagging
// productive edit-rerun cycles that happen to reuse the same commands. All
// "> N" checks fire on the (N+1)th repetition. Tuned by feel against
// observed agent traces; revisit if real loops slip past or productive
// workflows trip the guard.
const WINDOW_SIZE = 30 // upper bound on detectable loop period
const CONSECUTIVE_IDENTICAL_THRESHOLD = 3 // 3 calls in a row with identical output
const FUZZY_2GRAM_THRESHOLD = 6 // 7× repeat of a 2-gram, output may vary
const FUZZY_3GRAM_THRESHOLD = 4 // 5× repeat of a 3-gram, output may vary
const EXACT_2GRAM_THRESHOLD = 5 // 6× repeat of a 2-gram with identical output
const EXACT_3GRAM_THRESHOLD = 3 // 4× repeat of a 3-gram with identical output
const EDIT_RUN_THRESHOLD = 8 // same file edited 8× AND same bash prefix 8× in window
const EDIT_RUN_TOTAL_THRESHOLD = 12 // same file 12× AND same bash prefix 12× over the whole task
// Relaxed edit-run signal: same file edited N× without requiring the bash
// prefix to match. Catches loops where the agent varies its test/build
// commands (different make targets, different flags) but keeps patching the
// same file — a clear non-convergence signal the strict edit-run detector
// misses. Lowered from 8 to 5: the hardest failing benchmark tasks edit the
// same file exactly 5× before timing out, while the max same-file edit count
// across all 20 passing tasks is 3 (2× headroom at threshold 5).
// Window variant additionally requires N+ bash calls in window
// (any prefix) to confirm it's an edit→run cycle, not just sequential edits.
const REPEATED_EDIT_THRESHOLD = 5 // same file edited 5× in window with 5+ bash calls (any prefix)
const REPEATED_EDIT_TOTAL_THRESHOLD = 5 // same file edited 5× across the whole task (bash-independent)
// After a loop-guard warn, block calls matching the detected pattern for
// this many non-matching calls before clearing the block (cooldown).
const BLOCK_COOLDOWN_CALLS = 5
const BASH_REPEAT_THRESHOLD = 12 // bash-only: same prefix 12× in window (no edit required)
const BASH_REPEAT_TOTAL_THRESHOLD = 15 // bash-only: same prefix 15× across the task
const BASH_PREFIX_LENGTH = 50 // normalize bash commands by this prefix
const FINGERPRINT_TAIL_LINES = 20
const REASON_ARG_PREVIEW = 80

const STEERING_MESSAGE =
	"Loop guard: you are repeating the same edit-and-run cycle without making progress. " +
	"STOP and change your approach. Before your next tool call: " +
	"(1) State in one sentence what is failing and why. " +
	"(2) List at least two alternative approaches you have NOT tried. " +
	"(3) Pick the most promising one and try THAT instead. " +
	"Do not repeat the same file edits or the same commands — the loop guard will keep firing if you do."

// Second-fire escalation. A stronger, more directive message than the
// first fire — tells the model its previous approach is not converging
// and demands an explicit strategy change.
const STEERING_MESSAGE_2 =
	"Second loop warning. Your previous approach is not converging. " +
	"You MUST change strategy now: state in one sentence what is failing and why, " +
	"list two approaches you have NOT tried, and pick the most promising one. " +
	"Do not repeat the same edits or commands."

// Third-and-beyond escalation. References prior ignored steers explicitly
// so the agent cannot pattern-match the message as ignorable noise, and
// offers a graceful exit (partial solution) instead of continued churning.
// {n} and {prev} are placeholder tokens replaced by buildSteerPrefix().
const STEERING_MESSAGE_N =
	"Loop warning #{n}. You have ignored {prev} previous loop-guard steers and are still " +
	"not making verifiable progress. Stop editing and running the same kinds of commands. " +
	"Re-read the task requirements from first principles. If you cannot complete the task, " +
	"write the best partial solution you have, run whatever verification exists, and summarize " +
	"what is blocking you — do not keep churning."

/** Build the escalating steer prefix for the given session-wide warn count.
 *  warnCount starts at 1 on the first warn. The first-fire message is
 *  unchanged from the original advisory to preserve existing behavior for
 *  signature-detector first fires. */
function buildSteerPrefix(warnCount: number): string {
	if (warnCount <= 1) return STEERING_MESSAGE
	if (warnCount === 2) return STEERING_MESSAGE_2
	return STEERING_MESSAGE_N.replace("{n}", String(warnCount)).replace("{prev}", String(warnCount - 1))
}

/**
 * Detects when an agent is stuck repeating itself across tool calls. Four
 * independent detectors run over a rolling window of the most recent records
 * and share a single warning fuse: the first detection from any detector
 * issues a warning; the next detection terminates tool use for the turn.
 *
 * Detectors:
 *   1. Consecutive identical calls — N calls in a row with matching tool
 *      name, args, isError flag, and output fingerprint. The error flag is
 *      not special-cased: an agent re-running the same successful query and
 *      getting the same answer is just as stuck as one retrying a failure.
 *   2. Exact n-gram repetition — a contiguous block of N calls (matching all
 *      four fields) repeats more times than the threshold allows.
 *   3. Fuzzy n-gram repetition — same as exact, but matches only on tool
 *      name + args. Catches edit/rerun loops where the output keeps changing
 *      but the agent is invoking the same calls in the same order.
 *   4. Edit-run cycle — a single file is edited repeatedly AND a single bash
 *      command prefix is run repeatedly within the window (non-contiguous).
 *      Catches the edit\u2192build\u2192run\u2192see-error\u2192edit cycle that detectors 1\u20133
 *      miss because the edit args change every iteration.
 *   5. Repeated edit cycle — a single file is edited N\u00d7 WITHOUT requiring
 *      the bash command prefix to match. A relaxed variant of (4) that
 *      catches loops where the agent varies its test/build commands
 *      (different make targets, different flags) but keeps patching the
 *      same file — a non-convergence signal the strict edit-run detector
 *      misses because no single bash prefix reaches threshold.
 */
export class LoopGuard {
	private history: ToolHistoryRecord[] = []
	private editCounts = new Map<string, number>()
	private bashCounts = new Map<string, number>()
	/** Cumulative counts for the whole task. Incremented on every record,
	 *  never decremented on eviction — catches interleaved edit-run cycles
	 *  that the 30-record window misses (e.g. when read/grep/ls calls are
	 *  interleaved with edits and the window count stays below 8). Cleared
	 *  on session_start / user input via `reset()`. */
	private editCountsTotal = new Map<string, number>()
	private bashCountsTotal = new Map<string, number>()
	/** Normalized bash prefix counts (window). Strips preamble commands
	 *  and collapses on tool+file so flag variations don't dodge detection. */
	private bashCountsNorm = new Map<string, number>()
	private bashCountsNormTotal = new Map<string, number>()
	private warned = false
	private triggered = false
	/** Patterns from prior loop-guard warns. After a warn fires, the edit
	 *  target and/or bash prefix that triggered it are stored here so
	 *  shouldBlock() can refuse subsequent calls that would extend the
	 *  same loop. Cleared on reset() or after BLOCK_COOLDOWN_CALLS
	 *  non-matching calls. */
	private blockedEditTargets = new Set<string>()
	private blockedBashPrefixes = new Set<string>()
	private blockedBashPrefixesNorm = new Set<string>()
	/** Non-matching call counter for the block cooldown. Incremented by
	 *  shouldBlock() only on non-matching edit/write/bash calls — the tool
	 *  types whose patterns are stored; diagnostic reads/greps/ls/find are
	 *  ignored so they can't burn the cooldown. Cleared when the cooldown
	 *  is reached (which also clears the blocked patterns). */
	private nonMatchingCallCount = 0

	reset(): void {
		this.history = []
		this.editCounts.clear()
		this.bashCounts.clear()
		this.editCountsTotal.clear()
		this.bashCountsTotal.clear()
		this.bashCountsNorm.clear()
		this.bashCountsNormTotal.clear()
		this.warned = false
		this.triggered = false
		this.blockedEditTargets.clear()
		this.blockedBashPrefixes.clear()
		this.blockedBashPrefixesNorm.clear()
		this.nonMatchingCallCount = 0
	}

	isTriggered(): boolean {
		return this.triggered
	}

	isWarned(): boolean {
		return this.warned
	}

	/** Test helper: get the current total count for a bash prefix. */
	getTotalBashCount(prefix: string): number {
		return this.bashCountsTotal.get(prefix) ?? 0
	}

	record(rec: ToolHistoryRecord): LoopGuardResult {
		// Increment semantic counters for the new record before pushing.
		const editTarget = extractEditTarget(rec)
		if (editTarget) {
			mapIncrement(this.editCounts, editTarget)
			mapIncrement(this.editCountsTotal, editTarget)
		}
		const bashPrefix = extractBashPrefix(rec)
		if (bashPrefix) {
			mapIncrement(this.bashCounts, bashPrefix)
			mapIncrement(this.bashCountsTotal, bashPrefix)
		}
		const bashPrefixNorm = extractBashPrefixNormalized(rec)
		if (bashPrefixNorm) {
			mapIncrement(this.bashCountsNorm, bashPrefixNorm)
			mapIncrement(this.bashCountsNormTotal, bashPrefixNorm)
		}

		this.history.push(rec)
		if (this.history.length > WINDOW_SIZE) {
			const evicted = this.history.shift()
			if (evicted !== undefined) {
				// Decrement semantic counters for the evicted record to keep them
				// in sync with the sliding window.
				const evictedEdit = extractEditTarget(evicted)
				if (evictedEdit) mapDecrement(this.editCounts, evictedEdit)
				const evictedBash = extractBashPrefix(evicted)
				if (evictedBash) mapDecrement(this.bashCounts, evictedBash)
				const evictedBashNorm = extractBashPrefixNormalized(evicted)
				if (evictedBashNorm) mapDecrement(this.bashCountsNorm, evictedBashNorm)
			}
		}

		const detected = this.detect()
		if (detected === undefined) {
			return { state: "ok" }
		}

		// Always warn, never terminate. Blocking tool calls forces the model
		// into no-tool turns which deadlocks with the exploration guard.
		this.warned = true

		// Store the detected pattern so shouldBlock() can block calls that
		// would extend the same loop. WHICH patterns are stored depends on
		// which detector fired — storing an unrelated pattern (e.g. an edit
		// target when bash_repetition fired, or a bash prefix when
		// repeated_edit fired) causes false-positive blocking of calls that
		// are not part of the detected loop. The window and task-total maps
		// still have their counts at this point (before the resets below),
		// so mapMax correctly identifies the pattern that crossed threshold
		// for edit-run and bash-repetition detectors.
		const detector = detected.detector
		if (detector === "edit_run") {
			// Window variant: both edit target and bash prefix crossed the
			// window threshold together. Fall back to the WINDOW maps only —
			// consulting the task-total maps would store a different file
			// when the window and task-total tops disagree.
			const warnEditTarget = extractEditTarget(rec) ?? mapMax(this.editCounts)?.[0]
			if (warnEditTarget) this.blockedEditTargets.add(warnEditTarget)
			const warnBashPrefix = extractBashPrefix(rec) ?? mapMax(this.bashCounts)?.[0]
			if (warnBashPrefix) this.blockedBashPrefixes.add(warnBashPrefix)
			const warnBashPrefixNorm = extractBashPrefixNormalized(rec) ?? mapMax(this.bashCountsNorm)?.[0]
			if (warnBashPrefixNorm) this.blockedBashPrefixesNorm.add(warnBashPrefixNorm)
		} else if (detector === "edit_run_total") {
			// Task-total variant: both edit target and bash prefix crossed
			// the task-total threshold together. Fall back to the TASK-TOTAL
			// maps only — the triggering record is often a bash call (the
			// Nth bash that pushes bashCountsTotal to threshold while the
			// edit count was already met), so extractEditTarget(rec) is
			// undefined and the window map may point to a different,
			// unrelated file that was recently edited in the window.
			const warnEditTarget = extractEditTarget(rec) ?? mapMax(this.editCountsTotal)?.[0]
			if (warnEditTarget) this.blockedEditTargets.add(warnEditTarget)
			const warnBashPrefix = extractBashPrefix(rec) ?? mapMax(this.bashCountsTotal)?.[0]
			if (warnBashPrefix) this.blockedBashPrefixes.add(warnBashPrefix)
			const warnBashPrefixNorm = extractBashPrefixNormalized(rec) ?? mapMax(this.bashCountsNormTotal)?.[0]
			if (warnBashPrefixNorm) this.blockedBashPrefixesNorm.add(warnBashPrefixNorm)
		} else if (detector === "repeated_edit") {
			// Only the edit target is part of this loop. Bash prefixes vary
			// by design (that's why the strict edit_run detector didn't fire),
			// so storing a bash prefix would block an unrelated command.
			//
			// The repeated_edit detector has two variants that share the same
			// detector string: a window variant (checks editCounts +
			// bashInWindow) and a task-total variant (checks editCountsTotal +
			// totalBash). The window variant is checked first in
			// detectRepeatedEditCycle, so if its condition is currently met,
			// it fired; otherwise the task-total variant fired. We must
			// consult the map that the firing variant actually checked —
			// consulting the window map when the task-total variant fired
			// (or vice versa) stores the wrong file when the two maps have
			// different top entries (common when edits are spread across
			// 80+ tool calls and recently evicted from the 30-record window).
			// The maps have NOT been reset yet at this point (window clears
			// and firedKeys deletion happen below), so re-checking gives the
			// same result as when detect() ran.
			const topEditWin = mapMax(this.editCounts)
			const bashInWindow = this.history.filter((r) => r.toolName === "bash").length
			const windowVariantFired =
				topEditWin !== undefined &&
				topEditWin[1] >= REPEATED_EDIT_THRESHOLD &&
				bashInWindow >= REPEATED_EDIT_THRESHOLD
			const warnEditTarget = extractEditTarget(rec) ??
				(windowVariantFired
					? mapMax(this.editCounts)?.[0]
					: mapMax(this.editCountsTotal)?.[0])
			if (warnEditTarget) this.blockedEditTargets.add(warnEditTarget)
		} else if (detector === "bash_repetition") {
			// Only the bash prefix is part of this loop. No edit target is
			// involved, so storing one would block an unrelated file edit.
			const warnBashPrefix = extractBashPrefix(rec) ?? mapMax(this.bashCounts)?.[0] ?? mapMax(this.bashCountsTotal)?.[0]
			if (warnBashPrefix) this.blockedBashPrefixes.add(warnBashPrefix)
			const warnBashPrefixNorm = extractBashPrefixNormalized(rec) ?? mapMax(this.bashCountsNorm)?.[0] ?? mapMax(this.bashCountsNormTotal)?.[0]
			if (warnBashPrefixNorm) this.blockedBashPrefixesNorm.add(warnBashPrefixNorm)
		} else {
			// N-gram detectors (consecutive_identical, exact_ngram,
			// fuzzy_ngram): the repeating call IS the pattern. Extract from
			// rec only — do NOT consult mapMax, which could return an
			// unrelated edit/bash that happens to be in the window. If rec
			// is a read/grep (no edit/bash signature), store nothing; the
			// advisory steer still fires.
			const warnEditTarget = extractEditTarget(rec)
			if (warnEditTarget) this.blockedEditTargets.add(warnEditTarget)
			const warnBashPrefix = extractBashPrefix(rec)
			if (warnBashPrefix) this.blockedBashPrefixes.add(warnBashPrefix)
			const warnBashPrefixNorm = extractBashPrefixNormalized(rec)
			if (warnBashPrefixNorm) this.blockedBashPrefixesNorm.add(warnBashPrefixNorm)
		}
		// Reset the cooldown so the block gets a fresh window of 5 calls.
		this.nonMatchingCallCount = 0

		// Reset the window counters so the model must loop again before the
		// next steer fires — avoids flooding the context with steers on
		// every subsequent tool call.
		this.history = []
		this.editCounts.clear()
		this.bashCounts.clear()
		this.bashCountsNorm.clear()

		// For task-total detectors, reset the specific keys that fired so
		// the same threshold doesn't fire on every subsequent record for
		// the rest of the session. The model must accumulate a fresh
		// batch of matching calls to re-trigger. Reset (not decrement by 1)
		// because the threshold was reached — partial carryover doesn't help.
		for (const key of detected.firedKeys) {
			this.editCountsTotal.delete(key)
			this.bashCountsTotal.delete(key)
			this.bashCountsNormTotal.delete(key)
		}

		// Return only the detector-specific detail; the extension builds the
		// escalating steer prefix from warnCount and appends this in parens.
		return { state: "warn", reason: detected.reason, detector: detected.detector }
	}

	/**
	 * Blocks `call` if executing it would extend an active loop. Only
	 * meaningful after a warning has been issued.
	 *
	 * Two checks run:
	 *
	 *   1. Edit-run extension — if the call targets the top edit file or uses
	 *      the top bash prefix, it would extend the existing edit-run cycle.
	 *      This check runs first and does not require a matching historical
	 *      record (the edit-run detector uses window-level counts, not
	 *      contiguity).
	 *
	 *   2. N-gram extension — if a historical record exists with matching tool
	 *      name + args (a "proxy"), the hypo is inserted in that slot and the
	 *      n-gram detectors are re-run. If no proxy exists, no n-gram can
	 *      possibly fire on a tail ending in this hypo, so we short-circuit.
	 *
	 * The edit-run detector is intentionally excluded from check (2). It uses
	 * aggregate window counts rather than contiguous patterns, so once the
	 * window is at threshold it would always return a reason regardless of
	 * what the new call does — that would over-block unrelated calls. Check
	 * (1) handles the actual "would this extend the cycle?" question.
	 */
	blockIfLoop(call: { toolName: string; toolArgs: string }): boolean {
		if (!this.warned || this.history.length === 0) return false

		// Edit-run extension check. Cheap: just four map lookups.
		// The window check catches concentrated cycles; the task-total check
		// catches interleaved ones where the same edit/bash pattern is
		// spread across many other tool calls.
		const hypoForExtract: ToolHistoryRecord = {
			toolName: call.toolName,
			toolArgs: call.toolArgs,
			isError: false,
			outputFingerprint: "",
		}
		const callEditTarget = extractEditTarget(hypoForExtract)
		const callBashPrefix = extractBashPrefix(hypoForExtract)
		const topEdit = mapMax(this.editCounts)
		const topBash = mapMax(this.bashCounts)
		const topEditTotal = mapMax(this.editCountsTotal)
		const topBashTotal = mapMax(this.bashCountsTotal)
		const extendsWindowCycle =
			(callEditTarget !== undefined &&
				topEdit !== undefined &&
				callEditTarget === topEdit[0] &&
				topEdit[1] >= EDIT_RUN_THRESHOLD) ||
			(callBashPrefix !== undefined &&
				topBash !== undefined &&
				callBashPrefix === topBash[0] &&
				topBash[1] >= EDIT_RUN_THRESHOLD)
		const extendsTotalCycle =
			(callEditTarget !== undefined &&
				topEditTotal !== undefined &&
				callEditTarget === topEditTotal[0] &&
				topEditTotal[1] >= EDIT_RUN_TOTAL_THRESHOLD) ||
			(callBashPrefix !== undefined &&
				topBashTotal !== undefined &&
				callBashPrefix === topBashTotal[0] &&
				topBashTotal[1] >= EDIT_RUN_TOTAL_THRESHOLD)
		if (extendsWindowCycle || extendsTotalCycle) {
			this.triggered = true
			return true
		}

		// N-gram extension check (existing logic).
		let proxy: ToolHistoryRecord | undefined
		for (let i = this.history.length - 1; i >= 0; i--) {
			const r = this.history[i]
			if (r.toolName === call.toolName && r.toolArgs === call.toolArgs) {
				proxy = r
				break
			}
		}
		if (!proxy) return false
		const hypo: ToolHistoryRecord = {
			toolName: call.toolName,
			toolArgs: call.toolArgs,
			isError: proxy.isError,
			outputFingerprint: proxy.outputFingerprint,
		}
		const saved = this.history
		this.history = [...saved.slice(-(WINDOW_SIZE - 1)), hypo]
		try {
			if (this.detectNgramOnly() === undefined) return false
			this.triggered = true
			return true
		} finally {
			this.history = saved
		}
	}

	/**
	 * Check whether a tool call should be blocked because it matches a
	 * pattern from a recent loop-guard warn. Unlike blockIfLoop (which
	 * checks the current window state and is ineffective after a warn
	 * resets the window), this method checks against stored blocked
	 * patterns from prior warns.
	 *
	 * Returns { block: true, reason } if the call matches a blocked
	 * edit target or bash prefix. Returns { block: false } otherwise.
	 * The non-matching call counter is incremented only for edit/write/
	 * bash calls (the tool types whose patterns are stored); diagnostic
	 * reads/greps/ls/find pass through without advancing the cooldown, so
	 * the block persists until the agent makes 5 alternative edit/bash
	 * calls. After BLOCK_COOLDOWN_CALLS such calls, the blocked patterns
	 * are cleared.
	 *
	 * NOTE: As of iteration 0014 this method is DEAD CODE — the tool_call
	 * handler no longer consults it (advisory-only behavior). It is
	 * retained, along with blockIfLoop and the blockedEditTargets /
	 * blockedBashPrefixes / blockedBashPrefixesNorm state, for potential
	 * content-aware re-enablement (a future block must key on edit
	 * content, not file path). Do not re-wire it without that change.
	 */
	shouldBlock(call: { toolName: string; toolArgs: string }): { block: boolean; reason?: string } {
		if (
			this.blockedEditTargets.size === 0 &&
			this.blockedBashPrefixes.size === 0 &&
			this.blockedBashPrefixesNorm.size === 0
		) {
			return { block: false }
		}

		const hypo: ToolHistoryRecord = {
			toolName: call.toolName,
			toolArgs: call.toolArgs,
			isError: false,
			outputFingerprint: "",
		}
		const callEditTarget = extractEditTarget(hypo)
		const callBashPrefix = extractBashPrefix(hypo)
		const callBashPrefixNorm = extractBashPrefixNormalized(hypo)

		if (callEditTarget && this.blockedEditTargets.has(callEditTarget)) {
			return {
				block: true,
				reason:
					`Loop guard: this edit to ${callEditTarget} would extend a detected loop. ` +
					"The loop guard has warned you about repeating this pattern. " +
					"Try a different file, a different approach, or re-read the task requirements " +
					"before continuing.",
			}
		}
		if (callBashPrefix && this.blockedBashPrefixes.has(callBashPrefix)) {
			return {
				block: true,
				reason:
					"Loop guard: this bash command would extend a detected loop. " +
					"The loop guard has warned you about repeating this pattern. " +
					"Try a different command, a different approach, or re-read the task requirements " +
					"before continuing.",
			}
		}
		if (callBashPrefixNorm && this.blockedBashPrefixesNorm.has(callBashPrefixNorm)) {
			return {
				block: true,
				reason:
					"Loop guard: this bash command would extend a detected loop. " +
					"The loop guard has warned you about repeating this pattern. " +
					"Try a different command, a different approach, or re-read the task requirements " +
					"before continuing.",
			}
		}

		// Non-matching call. Only edit/write/bash calls count toward the
		// cooldown: these are the tool types whose patterns are stored, and
		// the cooldown should measure approach-changing attempts, not
		// diagnostic reads/greps/ls/find. Without this guard, the agent's
		// typical post-warn sequence (blocked edit → read error → read
		// source → grep → read → read) would clear the block via benign
		// diagnostic calls, after which it resumes the exact same loop.
		const isLoopExtendingTool =
			callEditTarget !== undefined ||
			callBashPrefix !== undefined ||
			callBashPrefixNorm !== undefined
		if (isLoopExtendingTool) {
			this.nonMatchingCallCount++
			if (this.nonMatchingCallCount >= BLOCK_COOLDOWN_CALLS) {
				this.blockedEditTargets.clear()
				this.blockedBashPrefixes.clear()
				this.blockedBashPrefixesNorm.clear()
				this.nonMatchingCallCount = 0
			}
		}

		return { block: false }
	}

	/** Run all detectors and return the first one that fires, along with
	 *  any map keys that should be decremented when the caller resets
	 *  state. Task-total keys are included so the caller can decrement
	 *  them after a warn — otherwise the same task-total threshold would
	 *  fire on every subsequent record for the rest of the session. */
	private detect(): { reason: string; firedKeys: string[]; detector: LoopGuardDetector } | undefined {
		return (
			this.detectConsecutiveIdenticalCalls() ??
			this.detectExactNgram() ??
			this.detectFuzzyNgram() ??
			this.detectEditRunCycle() ??
			this.detectEditRunCycleTotal() ??
			this.detectRepeatedEditCycle() ??
			this.detectBashRepetition()
		)
	}

	private detectNgramOnly(): { reason: string; firedKeys: string[]; detector: LoopGuardDetector } | undefined {
		return this.detectConsecutiveIdenticalCalls() ?? this.detectExactNgram() ?? this.detectFuzzyNgram()
	}

	private detectConsecutiveIdenticalCalls():
		| { reason: string; firedKeys: string[]; detector: LoopGuardDetector }
		| undefined {
		const last = this.history[this.history.length - 1]
		if (!last) return undefined
		const targetKey = exactKey(last)
		let count = 0
		for (let i = this.history.length - 1; i >= 0; i--) {
			if (exactKey(this.history[i]) === targetKey) {
				count++
			} else {
				break
			}
		}
		if (count < CONSECUTIVE_IDENTICAL_THRESHOLD) return undefined
		return {
			reason: `${count} consecutive identical calls of ${formatCall(last)} producing identical output`,
			firedKeys: [],
			detector: "consecutive_identical",
		}
	}

	private detectExactNgram(): { reason: string; firedKeys: string[]; detector: LoopGuardDetector } | undefined {
		const r2 = countContiguousNgramReps(this.history, 2, exactKey)
		if (r2 > EXACT_2GRAM_THRESHOLD) {
			return {
				reason: formatLoopReason(this.history, 2, r2, "identical results"),
				firedKeys: [],
				detector: "exact_ngram",
			}
		}
		const r3 = countContiguousNgramReps(this.history, 3, exactKey)
		if (r3 > EXACT_3GRAM_THRESHOLD) {
			return {
				reason: formatLoopReason(this.history, 3, r3, "identical results"),
				firedKeys: [],
				detector: "exact_ngram",
			}
		}
		return undefined
	}

	private detectFuzzyNgram(): { reason: string; firedKeys: string[]; detector: LoopGuardDetector } | undefined {
		const r2 = countContiguousNgramReps(this.history, 2, fuzzyKey)
		if (r2 > FUZZY_2GRAM_THRESHOLD) {
			return { reason: formatLoopReason(this.history, 2, r2, "same arguments"), firedKeys: [], detector: "fuzzy_ngram" }
		}
		const r3 = countContiguousNgramReps(this.history, 3, fuzzyKey)
		if (r3 > FUZZY_3GRAM_THRESHOLD) {
			return { reason: formatLoopReason(this.history, 3, r3, "same arguments"), firedKeys: [], detector: "fuzzy_ngram" }
		}
		return undefined
	}

	private detectEditRunCycle(): { reason: string; firedKeys: string[]; detector: LoopGuardDetector } | undefined {
		const topEdit = mapMax(this.editCounts)
		const topBashRaw = mapMax(this.bashCounts)
		const topBashNorm = mapMax(this.bashCountsNorm)
		// Pick the higher of raw vs normalized bash count.
		const topBash = pickHigher(topBashRaw, topBashNorm)
		if (!topEdit || !topBash) return undefined
		if (topEdit[1] < EDIT_RUN_THRESHOLD || topBash[1] < EDIT_RUN_THRESHOLD) return undefined
		const editPreview =
			topEdit[0].length > REASON_ARG_PREVIEW ? `${topEdit[0].slice(0, REASON_ARG_PREVIEW)}…` : topEdit[0]
		const bashPreview =
			topBash[0].length > REASON_ARG_PREVIEW ? `${topBash[0].slice(0, REASON_ARG_PREVIEW)}…` : topBash[0]
		// firedKeys are empty: window counters are fully reset by the caller
		// after each warn, so we don't need to decrement individual keys.
		return {
			reason: `edit-run cycle: ${editPreview} edited ${topEdit[1]}× and bash "${bashPreview}" ran ${topBash[1]}× in last ${this.history.length} calls`,
			firedKeys: [],
			detector: "edit_run",
		}
	}

	private detectEditRunCycleTotal(): { reason: string; firedKeys: string[]; detector: LoopGuardDetector } | undefined {
		// Task-total counts catch interleaved loops that the 30-record
		// window misses. Window-based detection is still preferred because
		// it's sensitive to recent behaviour; this is a backstop for the
		// case where the model spreads the same edit/bash pattern over
		// 100+ rounds with other work interleaved (e.g. read/grep/ls).
		// Check both raw and normalized bash prefixes.
		const topEdit = mapMax(this.editCountsTotal)
		const topBashRaw = mapMax(this.bashCountsTotal)
		const topBashNorm = mapMax(this.bashCountsNormTotal)
		// Pick the higher of raw vs normalized bash count.
		const topBash = pickHigher(topBashRaw, topBashNorm)
		if (!topEdit || !topBash) return undefined
		if (topEdit[1] < EDIT_RUN_TOTAL_THRESHOLD || topBash[1] < EDIT_RUN_TOTAL_THRESHOLD) return undefined
		const editPreview =
			topEdit[0].length > REASON_ARG_PREVIEW ? `${topEdit[0].slice(0, REASON_ARG_PREVIEW)}…` : topEdit[0]
		const bashPreview =
			topBash[0].length > REASON_ARG_PREVIEW ? `${topBash[0].slice(0, REASON_ARG_PREVIEW)}…` : topBash[0]
		// Include the fired keys so the caller can decrement them in the
		// task-total maps. Without this, the same threshold would re-fire
		// on every subsequent tool call for the rest of the session.
		return {
			reason: `edit-run cycle (task-total): ${editPreview} edited ${topEdit[1]}× and bash "${bashPreview}" ran ${topBash[1]}× across the task`,
			firedKeys: [topEdit[0], topBash[0]],
			detector: "edit_run_total",
		}
	}

	/**
	 * Relaxed edit-run detector: fires when a single file is edited many
	 * times WITHOUT requiring the bash command prefix to match. This is a
	 * targeted relaxation of detectEditRunCycle / detectEditRunCycleTotal —
	 * it uses the same editCounts / editCountsTotal maps but drops the
	 * AND-with-bash-prefix condition that causes the strict detectors to
	 * miss loops where the agent varies its test/build commands (different
	 * make targets, different flags, different test invocations) while
	 * churning on the same file.
	 *
	 * Window variant: same file edited N× with N+ bash calls (any prefix) in
	 * the window. The bash-call count confirms it's an edit→run cycle, not
	 * just sequential edits without verification.
	 *
	 * Task-total variant: same file edited N× across the whole task.
	 * Catches spread-out loops where edits are interleaved with many
	 * reads/greps and the window never accumulates 8 edits at once.
	 */
	private detectRepeatedEditCycle():
		| { reason: string; firedKeys: string[]; detector: LoopGuardDetector }
		| undefined {
		// Window check: same file edited N× with N+ bash calls (any prefix).
		// The bash-call count confirms it's an edit→run cycle, not just
		// sequential edits without verification. Unlike detectEditRunCycle,
		// the bash prefix need NOT match — the repeated edit to the same
		// file is the signal.
		const topEdit = mapMax(this.editCounts)
		if (topEdit && topEdit[1] >= REPEATED_EDIT_THRESHOLD) {
			const bashInWindow = this.history.filter((r) => r.toolName === "bash").length
			if (bashInWindow >= REPEATED_EDIT_THRESHOLD) {
				const editPreview =
					topEdit[0].length > REASON_ARG_PREVIEW ? `${topEdit[0].slice(0, REASON_ARG_PREVIEW)}…` : topEdit[0]
				return {
					reason: `repeated edit cycle: ${editPreview} edited ${topEdit[1]}× with ${bashInWindow} bash calls in last ${this.history.length} calls (test commands vary but the same file keeps being patched without converging)`,
					// Include the fired file so the post-warn reset deletes its
					// task-total key too — otherwise the task-total variant
					// would fire on the very next record (its threshold is
					// also 8, and editCountsTotal is not cleared by the
					// window reset).
					firedKeys: [topEdit[0]],
					detector: "repeated_edit",
				}
			}
		}
		// Task-total check: same file edited N× across the whole task, AND
		// there have been N+ bash calls across the whole task (any prefix).
		// Catches spread-out loops where edits are interleaved with many
		// reads/greps and the 30-record window never accumulates 8 edits
		// at once. The total-bash requirement confirms it's an edit→run
		// cycle (not just sequential edits without verification) and lets
		// the stricter detectEditRunCycle / detectEditRunCycleTotal fire
		// first when they can — those need the SAME bash prefix, so when
		// bash prefixes vary and the strict detectors miss, this relaxed
		// variant catches the loop on total bash activity instead.
		//
		// totalBash sums bashCountsTotal (raw) values: every bash call
		// increments exactly one prefix's count, so the sum equals the
		// total number of bash calls across the task regardless of prefix.
		const topEditTotal = mapMax(this.editCountsTotal)
		if (topEditTotal && topEditTotal[1] >= REPEATED_EDIT_TOTAL_THRESHOLD) {
			let totalBash = 0
			for (const v of this.bashCountsTotal.values()) totalBash += v
			if (totalBash >= REPEATED_EDIT_TOTAL_THRESHOLD) {
				const editPreview =
					topEditTotal[0].length > REASON_ARG_PREVIEW
						? `${topEditTotal[0].slice(0, REASON_ARG_PREVIEW)}…`
						: topEditTotal[0]
				return {
					reason: `repeated edit cycle (task-total): ${editPreview} edited ${topEditTotal[1]}× across the task with ${totalBash} bash calls without converging`,
					firedKeys: [topEditTotal[0]],
					detector: "repeated_edit",
				}
			}
		}
		return undefined
	}

	/**
	 * Detects bash-only loops: the same command (raw or normalized prefix)
	 * repeated many times without requiring any file edits. Catches patterns
	 * like repeated yt-dlp downloads, repeated curl calls, repeated make on
	 * a project that always fails.
	 */
	private detectBashRepetition(): { reason: string; firedKeys: string[]; detector: LoopGuardDetector } | undefined {
		// Bash-only thresholds are higher than edit-run because the signal
		// is weaker (no paired file edit to confirm it's a loop).
		// Window check (raw)
		const topBashWin = mapMax(this.bashCounts)
		if (topBashWin && topBashWin[1] >= BASH_REPEAT_THRESHOLD) {
			return {
				reason: `bash repetition: "${truncPreview(topBashWin[0])}" ran ${topBashWin[1]}× in last ${this.history.length} calls`,
				firedKeys: [],
				detector: "bash_repetition",
			}
		}
		// Window check (normalized)
		const topBashNormWin = mapMax(this.bashCountsNorm)
		if (topBashNormWin && topBashNormWin[1] >= BASH_REPEAT_THRESHOLD) {
			return {
				reason: `bash repetition (normalized): "${truncPreview(topBashNormWin[0])}" ran ${topBashNormWin[1]}× in last ${this.history.length} calls`,
				firedKeys: [],
				detector: "bash_repetition",
			}
		}
		// Task-total check (raw)
		const topBashTotal = mapMax(this.bashCountsTotal)
		if (topBashTotal && topBashTotal[1] >= BASH_REPEAT_TOTAL_THRESHOLD) {
			return {
				reason: `bash repetition (task-total): "${truncPreview(topBashTotal[0])}" ran ${topBashTotal[1]}× across the task`,
				firedKeys: [topBashTotal[0]],
				detector: "bash_repetition",
			}
		}
		// Task-total check (normalized)
		const topBashNormTotal = mapMax(this.bashCountsNormTotal)
		if (topBashNormTotal && topBashNormTotal[1] >= BASH_REPEAT_TOTAL_THRESHOLD) {
			return {
				reason: `bash repetition (normalized task-total): "${truncPreview(topBashNormTotal[0])}" ran ${topBashNormTotal[1]}× across the task`,
				firedKeys: [topBashNormTotal[0]],
				detector: "bash_repetition",
			}
		}
		return undefined
	}
}

// \u0000 cannot appear in stable-stringified JSON (control chars are always
// escaped) and is unused in tool names / hex fingerprints, so it is a
// collision-free field separator.
function exactKey(r: ToolHistoryRecord): string {
	return `${r.toolName}\u0000${r.toolArgs}\u0000${r.isError}\u0000${r.outputFingerprint}`
}

function fuzzyKey(r: ToolHistoryRecord): string {
	return `${r.toolName}\u0000${r.toolArgs}`
}

function formatCall(r: ToolHistoryRecord): string {
	const args = r.toolArgs.length > REASON_ARG_PREVIEW ? `${r.toolArgs.slice(0, REASON_ARG_PREVIEW)}…` : r.toolArgs
	return `${r.toolName}(${args})`
}

function formatLoopReason(history: ToolHistoryRecord[], n: number, reps: number, kind: string): string {
	const tail = history
		.slice(history.length - n)
		.map(formatCall)
		.join(", ")
	return `${n}-step loop repeated ${reps}× with ${kind}: [${tail}]`
}

/**
 * Counts the contiguous repetitions of the trailing n-gram at the end of
 * `history`. The last `n` records define the n-gram; we walk backwards in
 * blocks of `n` and count how many consecutive blocks compare equal under
 * `key`. Returns at least 1 when `history.length >= n`.
 */
function countContiguousNgramReps(
	history: ToolHistoryRecord[],
	n: number,
	key: (r: ToolHistoryRecord) => string,
): number {
	if (history.length < n) return 0
	const tailStart = history.length - n
	const tailKeys: string[] = []
	for (let i = 0; i < n; i++) tailKeys.push(key(history[tailStart + i]))
	let reps = 1
	while (history.length >= (reps + 1) * n) {
		const start = history.length - (reps + 1) * n
		let match = true
		for (let i = 0; i < n; i++) {
			if (key(history[start + i]) !== tailKeys[i]) {
				match = false
				break
			}
		}
		if (!match) break
		reps++
	}
	return reps
}

/**
 * SHA-256 hex digest of the last `tailLines` lines of `output`. If the
 * output has fewer lines, the entire content is hashed. No normalization is
 * applied, so trivially different output (whitespace, timestamps, counters)
 * produces a different fingerprint by design.
 */
export function fingerprint(output: string, tailLines: number = FINGERPRINT_TAIL_LINES): string {
	const lines = output.split("\n")
	const tail = lines.length <= tailLines ? lines : lines.slice(-tailLines)
	return createHash("sha256").update(tail.join("\n")).digest("hex")
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value)
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`
	}
	const obj = value as Record<string, unknown>
	const entries = Object.keys(obj)
		.sort()
		.filter((k) => obj[k] !== undefined)
		.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
	return `{${entries.join(",")}}`
}

function extractOutputText(content: ToolResultEvent["content"]): string {
	const parts: string[] = []
	for (const item of content) {
		if (item.type === "text") parts.push(item.text)
	}
	return parts.join("\n")
}

/**
 * Extract the file path from an edit or write tool record. Returns undefined
 * for other tools or when the path is missing or non-string.
 *
 * The toolArgs string is the stable-stringified JSON produced by the harness.
 * JSON.parse round-trips it cleanly; the edit/write schemas both use a `path`
 * string field.
 */
function extractEditTarget(rec: ToolHistoryRecord): string | undefined {
	if (rec.toolName !== "edit" && rec.toolName !== "write") return undefined
	try {
		const args = JSON.parse(rec.toolArgs) as { path?: unknown }
		return typeof args.path === "string" ? args.path : undefined
	} catch {
		return undefined
	}
}

/**
 * Extract a raw command prefix from a bash tool record. Returns
 * undefined for other tools or when the command is missing or non-string.
 *
 * The prefix length is intentionally short: it groups commands that share an
 * invocation intent ("cd /app && make -j8 all 2>&1 | tail -20" matches
 * "cd /app && make -j8 all 2>&1 | tail -60") while keeping distinct commands
 * separate ("cd /app && make test" vs "cd /app && npm test").
 */
function extractBashPrefix(rec: ToolHistoryRecord): string | undefined {
	if (rec.toolName !== "bash") return undefined
	try {
		const args = JSON.parse(rec.toolArgs) as { command?: unknown }
		return typeof args.command === "string" ? args.command.slice(0, BASH_PREFIX_LENGTH) : undefined
	} catch {
		return undefined
	}
}

/**
 * Commands that are pure side-effects or preamble — not the "core intent"
 * of a compound command. When normalizing, these are skipped to find the
 * first meaningful command segment.
 */
const PREAMBLE_COMMANDS = new Set([
	"rm",
	"echo",
	"wc",
	"sleep",
	"cd",
	"mkdir",
	"printf",
	"export",
	"test",
	"true",
	"false",
	"set",
	"unset",
])

/**
 * Extract a normalized bash prefix that strips common preamble (rm, echo,
 * wc, cd, etc.) and collapses on `<tool> <first-path-argument>`. This
 * catches loops where the model varies flags or preamble but the core
 * intent is the same (e.g. `rm -f a.out && gcc -O3 file.c` and
 * `wc -c file.c && gcc -O0 file.c` both normalize to `gcc file.c`).
 *
 * Returns undefined for non-bash tools.
 */
export function extractBashPrefixNormalized(rec: ToolHistoryRecord): string | undefined {
	if (rec.toolName !== "bash") return undefined
	try {
		const args = JSON.parse(rec.toolArgs) as { command?: unknown }
		if (typeof args.command !== "string") return undefined
		return normalizeBashCommand(args.command)
	} catch {
		return undefined
	}
}

/** Exported for testing. */
export function normalizeBashCommand(command: string): string {
	// Split on compound operators and newlines to get individual segments.
	const segments = command.split(/\s*(?:&&|\|\||;|\n)\s*/)
	for (const seg of segments) {
		const trimmed = seg.trim()
		if (!trimmed) continue
		const tokens = trimmed.split(/\s+/)
		const tool = tokens[0]
		if (!tool || PREAMBLE_COMMANDS.has(tool)) continue
		// Found the core command. Extract <tool> <first-path-argument>
		// to collapse flag variations (gcc -O0 file.c ≈ gcc -O3 file.c).
		const pathArg = tokens.slice(1).find((t) => !t.startsWith("-") && (t.includes("/") || /\.[a-zA-Z]/.test(t)))
		if (pathArg) {
			return `${tool} ${pathArg}`
		}
		// No path argument — fall back to raw prefix of the core command.
		return trimmed.slice(0, BASH_PREFIX_LENGTH)
	}
	// All segments are preamble — use the full command prefix.
	return command.slice(0, BASH_PREFIX_LENGTH)
}

function mapIncrement(map: Map<string, number>, key: string): void {
	map.set(key, (map.get(key) ?? 0) + 1)
}

function mapDecrement(map: Map<string, number>, key: string): void {
	const v = (map.get(key) ?? 0) - 1
	if (v <= 0) map.delete(key)
	else map.set(key, v)
}

/** Return the [key, value] pair with the highest count, or undefined if empty. */
function mapMax(map: Map<string, number>): [string, number] | undefined {
	let best: [string, number] | undefined
	for (const [k, v] of map) {
		if (!best || v > best[1]) best = [k, v]
	}
	return best
}

/** Pick whichever of two optional [key, count] pairs has the higher count. */
function pickHigher(a: [string, number] | undefined, b: [string, number] | undefined): [string, number] | undefined {
	if (!a) return b
	if (!b) return a
	return a[1] >= b[1] ? a : b
}

/** Truncate a string for display in reason messages. */
function truncPreview(s: string): string {
	return s.length > REASON_ARG_PREVIEW ? `${s.slice(0, REASON_ARG_PREVIEW)}…` : s
}

export default function loopGuardExtension(pi: ExtensionAPI) {
	const guard = new LoopGuard()
	let ctx: ExtensionContext | undefined
	/** True when a subagent loop-guard steer has fired and the subagent
	 *  gets one more turn to produce a summary before abort. */
	let subagentAbortPending = false
	/** Per-session count of loop-guard warns. Reset alongside guard.reset().
	 *  Carried into telemetry payloads so the backend can track frequency. */
	let warnCount = 0
	/** Stash the detector + count from the last warn so the subagent_abort
	 *  event can reference them when the abort fires in turn_end. */
	let lastWarnDetector: LoopGuardDetector | undefined
	let lastWarnCount = 0

	// Domain event helper: emit a loop-guard event via pi.events. No-ops
	// silently when `pi.events` is unavailable on the host.
	// Typed overloads ensure the payload matches the channel, catching
	// drift between the emit site and the telemetry subscription.
	function emitGuardEvent(channel: typeof LOOP_GUARD_EVENTS.WARN, payload: LoopGuardWarnPayload): void
	function emitGuardEvent(
		channel: typeof LOOP_GUARD_EVENTS.SUBAGENT_ABORT,
		payload: LoopGuardSubagentAbortPayload,
	): void
	function emitGuardEvent(channel: LoopGuardEventChannel, payload: unknown): void {
		try {
			pi.events.emit(channel, payload)
		} catch {
			// Older pi-coding-agent versions may not expose `events`. The
			// guard still functions correctly without telemetry.
		}
	}

	pi.on("session_start", (_event, _ctx) => {
		ctx = _ctx
		warnCount = 0
		lastWarnDetector = undefined
		lastWarnCount = 0
	})

	pi.on("input", (event) => {
		if (event.source === "extension") return
		guard.reset()
		subagentAbortPending = false
		warnCount = 0
		lastWarnDetector = undefined
		lastWarnCount = 0
	})

	pi.on("tool_call", (event) => {
		if (!event.toolName) {
			return {
				block: true,
				reason: "Tool name is empty. Check your tool call syntax and use only the tools listed under Available Tools.",
			}
		}
		// Advisory-only: the loop guard never blocks tool calls. The advisory
		// steer in the tool_result handler informs the agent when it is
		// looping and nudges it to change approach, but it does not prevent
		// the agent from taking recovery actions — including rewriting the
		// same file from scratch, which a path-keyed block would wrongly
		// refuse (see iteration 0014 hypothesis). shouldBlock/blockIfLoop
		// and the blockedEditTargets/blockedBashPrefixes state are retained
		// below as dead code for potential content-aware re-enablement but
		// are no longer consulted by this handler.
		return { block: false }
	})

	pi.on("turn_end", () => {
		// Subagent abort: after a loop-guard steer fired, the subagent gets
		// one turn to produce output, then we abort. Whatever it produced
		// becomes the responseText the orchestrator receives.
		if (subagentAbortPending) {
			emitGuardEvent(LOOP_GUARD_EVENTS.SUBAGENT_ABORT, {
				detector: lastWarnDetector,
				count: lastWarnCount,
				is_subagent: true,
			})
			ctx?.abort()
			subagentAbortPending = false
			return
		}
	})

	pi.on("tool_result", (event) => {
		const record: ToolHistoryRecord = {
			toolName: event.toolName,
			toolArgs: stableStringify(event.input),
			isError: event.isError,
			outputFingerprint: fingerprint(extractOutputText(event.content)),
		}
		const result = guard.record(record)
		if (result.state === "warn" && result.reason) {
			warnCount++
			lastWarnDetector = result.detector
			lastWarnCount = warnCount
			emitGuardEvent(LOOP_GUARD_EVENTS.WARN, {
				detector: result.detector ?? "consecutive_identical",
				count: warnCount,
				is_subagent: isAgentWorker(),
			})
			// Build the escalating steer message. The prefix escalates with
			// warnCount (first fire unchanged; 2nd stronger; 3rd+ references
			// prior ignored steers). The detector-specific detail is appended
			// in parentheses so the agent sees WHICH detector fired.
			const steerText = `${buildSteerPrefix(warnCount)} (${result.reason})`
			pi.sendMessage(
				{
					customType: "loop-guard-steer",
					content: [{ type: "text", text: steerText }],
					display: false,
				},
				{ deliverAs: "steer" },
			)
			// Subagent: schedule an abort on the next turn_end. The subagent
			// gets one more turn to produce a summary; that text becomes the
			// output the orchestrator receives.
			if (isAgentWorker()) {
				subagentAbortPending = true
			}
		}
	})
}
