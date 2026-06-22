import { createHash } from "node:crypto"
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent"

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
const BASH_PREFIX_LENGTH = 50 // normalize bash commands by this prefix
const FINGERPRINT_TAIL_LINES = 20
const REASON_ARG_PREVIEW = 80

const STEERING_MESSAGE =
	"Loop guard warning: your recent tool calls show a repeating pattern. Step back, summarize what isn't working, and try a substantively different approach. Repeating the same pattern will halt tool use for this turn."

const TERMINATION_MESSAGE =
	"Loop guard halted tool use. Do not make any more tool calls. Respond with plain text only: summarize what was attempted, what failed, and what you would need to make progress."

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
 */
export class LoopGuard {
	private history: ToolHistoryRecord[] = []
	private editCounts = new Map<string, number>()
	private bashCounts = new Map<string, number>()
	private warned = false
	private triggered = false

	reset(): void {
		this.history = []
		this.editCounts.clear()
		this.bashCounts.clear()
		this.warned = false
		this.triggered = false
	}

	isTriggered(): boolean {
		return this.triggered
	}

	isWarned(): boolean {
		return this.warned
	}

	record(rec: ToolHistoryRecord): LoopGuardResult {
		// Increment semantic counters for the new record before pushing.
		const editTarget = extractEditTarget(rec)
		if (editTarget) mapIncrement(this.editCounts, editTarget)
		const bashPrefix = extractBashPrefix(rec)
		if (bashPrefix) mapIncrement(this.bashCounts, bashPrefix)

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
			}
		}

		const reason = this.detect()
		if (reason === undefined) {
			return { state: "ok" }
		}

		if (!this.warned) {
			this.warned = true
			return { state: "warn", reason: `${STEERING_MESSAGE} (${reason})` }
		}

		this.triggered = true
		return { state: "terminate", reason: TERMINATION_MESSAGE }
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

		// Edit-run extension check. Cheap: just two map lookups.
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
		if (
			(callEditTarget !== undefined &&
				topEdit !== undefined &&
				callEditTarget === topEdit[0] &&
				topEdit[1] >= EDIT_RUN_THRESHOLD) ||
			(callBashPrefix !== undefined &&
				topBash !== undefined &&
				callBashPrefix === topBash[0] &&
				topBash[1] >= EDIT_RUN_THRESHOLD)
		) {
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

	private detect(): string | undefined {
		return (
			this.detectConsecutiveIdenticalCalls() ??
			this.detectExactNgram() ??
			this.detectFuzzyNgram() ??
			this.detectEditRunCycle()
		)
	}

	private detectNgramOnly(): string | undefined {
		return this.detectConsecutiveIdenticalCalls() ?? this.detectExactNgram() ?? this.detectFuzzyNgram()
	}

	private detectConsecutiveIdenticalCalls(): string | undefined {
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
		return `${count} consecutive identical calls of ${formatCall(last)} producing identical output`
	}

	private detectExactNgram(): string | undefined {
		const r2 = countContiguousNgramReps(this.history, 2, exactKey)
		if (r2 > EXACT_2GRAM_THRESHOLD) return formatLoopReason(this.history, 2, r2, "identical results")
		const r3 = countContiguousNgramReps(this.history, 3, exactKey)
		if (r3 > EXACT_3GRAM_THRESHOLD) return formatLoopReason(this.history, 3, r3, "identical results")
		return undefined
	}

	private detectFuzzyNgram(): string | undefined {
		const r2 = countContiguousNgramReps(this.history, 2, fuzzyKey)
		if (r2 > FUZZY_2GRAM_THRESHOLD) return formatLoopReason(this.history, 2, r2, "same arguments")
		const r3 = countContiguousNgramReps(this.history, 3, fuzzyKey)
		if (r3 > FUZZY_3GRAM_THRESHOLD) return formatLoopReason(this.history, 3, r3, "same arguments")
		return undefined
	}

	private detectEditRunCycle(): string | undefined {
		const topEdit = mapMax(this.editCounts)
		const topBash = mapMax(this.bashCounts)
		if (!topEdit || !topBash) return undefined
		if (topEdit[1] < EDIT_RUN_THRESHOLD || topBash[1] < EDIT_RUN_THRESHOLD) return undefined
		const editPreview =
			topEdit[0].length > REASON_ARG_PREVIEW ? `${topEdit[0].slice(0, REASON_ARG_PREVIEW)}…` : topEdit[0]
		const bashPreview =
			topBash[0].length > REASON_ARG_PREVIEW ? `${topBash[0].slice(0, REASON_ARG_PREVIEW)}…` : topBash[0]
		return `edit-run cycle: ${editPreview} edited ${topEdit[1]}× and bash "${bashPreview}" ran ${topBash[1]}× in last ${this.history.length} calls`
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
 * Extract a normalized command prefix from a bash tool record. Returns
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

export default function loopGuardExtension(pi: ExtensionAPI) {
	const guard = new LoopGuard()

	pi.on("input", (event) => {
		if (event.source === "extension") return
		guard.reset()
	})

	pi.on("tool_call", (event) => {
		if (!event.toolName) {
			return {
				block: true,
				reason: "Tool name is empty. Check your tool call syntax and use only the tools listed under Available Tools.",
			}
		}
		if (guard.isTriggered()) {
			return { block: true, reason: TERMINATION_MESSAGE }
		}
		const call = { toolName: event.toolName, toolArgs: stableStringify(event.input) }
		if (guard.blockIfLoop(call)) {
			return { block: true, reason: TERMINATION_MESSAGE }
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
			pi.sendMessage(
				{
					customType: "loop-guard-steer",
					content: [{ type: "text", text: result.reason }],
					display: false,
				},
				{ deliverAs: "steer" },
			)
		}
	})
}
